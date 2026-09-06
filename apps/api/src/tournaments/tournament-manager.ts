import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { CryptoRandomProvider } from '@river/poker-engine';
import { ChipsService } from '../chips/chips.service';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../infra/prisma/prisma.service';
import { RedisService } from '../infra/redis/redis.service';
import { realTimers } from '../tables/table-runner';
import {
  type TournamentPublicEvent,
  type TournamentRunnerDeps,
  TournamentRunner,
} from './tournament-runner';
import { TournamentRecoveryError, type TournamentSnapshot } from './tournament-recovery';

type TournamentListener = (tournamentId: string, ev: TournamentPublicEvent) => void;

/** Runtime checkpoint TTL. Matches the cash game's 2h. A short-lived
 * `finished` marker uses a much smaller window - just long enough for a client
 * that was mid-reconnect when the tournament ended to be told the outcome. */
const SNAPSHOT_TTL_SECONDS = 2 * 60 * 60;
const FINISHED_MARKER_TTL_SECONDS = 15 * 60;

/**
 * Owns one `TournamentRunner` per running tournament (single-writer actors, the
 * same pattern as `TableManager`). Everything - the coordinator and every one
 * of its tables - lives in this one API process; the deployment must stay at a
 * single machine.
 *
 * Restart recovery (ADR-0025): on boot this scans for `RUNNING` / `PAUSED`
 * tournament rows and rehydrates each coordinator from its Redis checkpoint.
 * There is never more than one runner per tournament id in the process
 * (`runners` + an in-flight `recovering` guard). A tournament whose checkpoint
 * is missing / stale / corrupt is left untouched - fail closed, a human decides.
 */
@Injectable()
export class TournamentManager implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TournamentManager.name);
  private readonly runners = new Map<string, TournamentRunner>();
  private readonly listeners = new Set<TournamentListener>();
  /** In-flight recovery per tournament id - dedupes concurrent `recover` calls
   * so two runners can never be built for the same tournament. */
  private readonly recovering = new Map<string, Promise<void>>();
  /** Latest checkpoint waiting to be written per tournament, and which ids have
   * a write in flight. The runner fires a checkpoint on every state change;
   * this coalesces bursts to "at most one in flight + the newest queued" so a
   * busy field never backs up more than one blob under Redis latency. */
  private readonly pendingSnapshot = new Map<string, TournamentSnapshot>();
  private readonly snapshotFlushing = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly chips: ChipsService,
    private readonly config: AppConfigService,
    private readonly redis: RedisService,
  ) {}

  onApplicationBootstrap(): void {
    void this.recoverAll();
  }

  onModuleDestroy(): void {
    for (const runner of this.runners.values()) runner.dispose();
    this.runners.clear();
  }

  /** The gateway subscribes here for every running tournament's live events. */
  subscribe(listener: TournamentListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(tournamentId: string, ev: TournamentPublicEvent): void {
    for (const l of this.listeners) {
      try {
        l(tournamentId, ev);
      } catch (err) {
        this.logger.error(`tournament listener error: ${(err as Error).message}`);
      }
    }
  }

  get(tournamentId: string): TournamentRunner | undefined {
    return this.runners.get(tournamentId);
  }

  /** Like `get`, but waits out an in-flight recovery first - the gateway calls
   * this so a client that reconnects while the boot scan is still running gets
   * the recovered runner rather than a spurious "not running". */
  async ensureRunner(tournamentId: string): Promise<TournamentRunner | undefined> {
    const pending = this.recovering.get(tournamentId);
    if (pending) await pending.catch(() => undefined);
    return this.runners.get(tournamentId);
  }

  /** The `finished` marker's standings, for a client reconnecting just after a
   * tournament settled (the live runner is already gone). */
  async finishedResults(
    tournamentId: string,
  ): Promise<{ userId: string; position: number; payout: number }[] | null> {
    const snap = await this.readSnapshot(tournamentId);
    return snap?.phase === 'finished' ? (snap.results ?? []) : null;
  }

  // --- lifecycle -----------------------------------------------------

  private runnerDeps(tournamentId: string): TournamentRunnerDeps {
    return {
      prisma: this.prisma,
      chips: this.chips,
      rng: new CryptoRandomProvider(),
      timers: realTimers,
      now: () => Date.now(),
      actionTimeoutMs: this.config.get('TABLE_ACTION_TIMEOUT_MS'),
      disconnectGraceMs: this.config.get('TABLE_DISCONNECT_GRACE_MS'),
      nextHandDelayMs: this.config.get('TABLE_NEXT_HAND_DELAY_MS'),
      publish: (ev) => this.emit(tournamentId, ev),
      persistSnapshot: (snap) => this.queueSnapshotWrite(tournamentId, snap),
      onFinished: (id) => {
        this.runners.get(id)?.dispose();
        this.runners.delete(id);
      },
    };
  }

  /** Stand up the coordinator and start play. Idempotent-ish: a second call
   * while one is already running throws (the caller has a stale view). */
  async start(tournamentId: string): Promise<TournamentRunner> {
    // A recovered tournament is already running - don't build a second runner.
    await this.ensureRunner(tournamentId);
    if (this.runners.has(tournamentId)) {
      throw new Error(`tournament ${tournamentId} is already running on this node`);
    }
    const runner = new TournamentRunner(tournamentId, this.runnerDeps(tournamentId));
    this.runners.set(tournamentId, runner);
    try {
      await runner.start();
    } catch (err) {
      this.runners.delete(tournamentId);
      runner.dispose();
      throw err;
    }
    return runner;
  }

  /** Tear a coordinator down (process shutdown / admin abort). Does not settle
   * payouts - only `FINISHED` via the normal path does that. */
  stop(tournamentId: string): void {
    const runner = this.runners.get(tournamentId);
    if (runner) {
      runner.dispose();
      this.runners.delete(tournamentId);
      this.logger.log(`stopped tournament ${tournamentId}`);
    }
    this.pendingSnapshot.delete(tournamentId);
    // Best effort. A stray blob for a non-RUNNING row is harmless - the boot
    // scan ignores it and it expires on its TTL.
    void this.deleteSnapshot(tournamentId);
  }

  // --- restart recovery --------------------------------------------

  /** Boot scan: rehydrate every tournament the DB still believes is live. */
  async recoverAll(): Promise<void> {
    let rows: { id: string }[];
    try {
      rows = await this.prisma.tournament.findMany({
        where: { status: { in: ['RUNNING', 'PAUSED'] } },
        select: { id: true },
      });
    } catch (err) {
      this.logger.error(`tournament recovery scan failed: ${(err as Error).message}`);
      return;
    }
    if (rows.length === 0) return;
    this.logger.log(`recovering ${rows.length} running tournament(s)`);
    await Promise.allSettled(rows.map((r) => this.recover(r.id)));
  }

  /**
   * Rehydrate one running tournament from its Redis checkpoint. Guarded so it
   * can be called twice (boot scan + a client reconnect) without ever building
   * two runners. Fails closed: a missing / stale / corrupt checkpoint leaves
   * the tournament with no runner and the row untouched - the loud log is the
   * signal for a human to inspect (and, if needed, CANCEL it, which refunds).
   */
  async recover(tournamentId: string): Promise<void> {
    if (this.runners.has(tournamentId)) return;
    const inFlight = this.recovering.get(tournamentId);
    if (inFlight) return inFlight;

    const task = this.doRecover(tournamentId).finally(() => this.recovering.delete(tournamentId));
    this.recovering.set(tournamentId, task);
    return task;
  }

  private async doRecover(tournamentId: string): Promise<void> {
    const startedAt = Date.now();
    const row = await this.prisma.tournament
      .findUnique({ where: { id: tournamentId }, select: { status: true, startedAt: true } })
      .catch(() => null);

    if (!row) {
      this.logger.error(`recover ${tournamentId}: no such tournament row`);
      return;
    }
    if (row.status !== 'RUNNING' && row.status !== 'PAUSED') {
      // A FINISHED / CANCELLED row must never spawn a runner.
      return;
    }
    if (row.startedAt === null) {
      this.logger.error(
        `recover ${tournamentId}: status ${row.status} but startedAt is null - cannot anchor the clock, failing closed`,
      );
      return;
    }

    // A RUNNING tournament should have a checkpoint. Retry a few times so a
    // transient Redis hiccup on boot doesn't strand a healthy tournament.
    let snapshot: TournamentSnapshot | null = null;
    for (let attempt = 0; attempt < 4 && !snapshot; attempt += 1) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * attempt));
      snapshot = await this.readSnapshot(tournamentId);
    }
    if (!snapshot) {
      this.logger.error(
        `recover ${tournamentId}: RUNNING row but no Redis checkpoint after retries - failing closed (no runner spawned; CANCEL to refund)`,
      );
      return;
    }

    const runner = new TournamentRunner(tournamentId, this.runnerDeps(tournamentId));
    try {
      await runner.resumeFromSnapshot(snapshot, row.startedAt.getTime());
    } catch (err) {
      runner.dispose();
      if (err instanceof TournamentRecoveryError) {
        this.logger.error(
          `recover ${tournamentId}: ${err.detail} - failing closed (no runner spawned)`,
        );
      } else {
        this.logger.error(
          `recover ${tournamentId}: unexpected error ${(err as Error).message} - failing closed`,
        );
      }
      return;
    }

    if (!runner.running) {
      // The tournament was on its last hand and the recovery finished it (the
      // settlement path ran, the DB is FINISHED, the marker is written). Nothing
      // live to register.
      runner.dispose();
      this.logger.log(`recover ${tournamentId}: tournament finished during recovery`);
      return;
    }

    this.runners.set(tournamentId, runner);
    this.logger.log(
      `recovered tournament ${tournamentId} in ${Date.now() - startedAt}ms ` +
        `(snapshot seq ${snapshot.seq}, written ${new Date(snapshot.writtenAtMs).toISOString()}, ` +
        `${snapshot.tables.length} table(s), ${snapshot.entries.length} entrants)`,
    );
  }

  // --- Redis checkpoint I/O ---------------------------------------

  private snapshotKey(tournamentId: string): string {
    return `tournament:${tournamentId}:snapshot`;
  }

  /** Queue a checkpoint write; newest wins, one flush loop per tournament. */
  private queueSnapshotWrite(tournamentId: string, snapshot: TournamentSnapshot): void {
    // A `finished` marker must never be overwritten by a late `running` blob.
    const pending = this.pendingSnapshot.get(tournamentId);
    if (pending?.phase === 'finished' && snapshot.phase !== 'finished') return;
    this.pendingSnapshot.set(tournamentId, snapshot);
    if (this.snapshotFlushing.has(tournamentId)) return;
    this.snapshotFlushing.add(tournamentId);
    void this.flushSnapshots(tournamentId);
  }

  private async flushSnapshots(tournamentId: string): Promise<void> {
    try {
      while (this.pendingSnapshot.has(tournamentId)) {
        const snap = this.pendingSnapshot.get(tournamentId) as TournamentSnapshot;
        this.pendingSnapshot.delete(tournamentId);
        await this.writeSnapshot(tournamentId, snap);
      }
    } finally {
      this.snapshotFlushing.delete(tournamentId);
    }
  }

  private async writeSnapshot(tournamentId: string, snapshot: TournamentSnapshot): Promise<void> {
    try {
      const ttl =
        snapshot.phase === 'finished' ? FINISHED_MARKER_TTL_SECONDS : SNAPSHOT_TTL_SECONDS;
      await this.redis.client.set(
        this.snapshotKey(tournamentId),
        JSON.stringify(snapshot),
        'EX',
        ttl,
      );
    } catch (err) {
      this.logger.warn(`checkpoint ${tournamentId}: ${(err as Error).message}`);
    }
  }

  private async readSnapshot(tournamentId: string): Promise<TournamentSnapshot | null> {
    try {
      const raw = await this.redis.client.get(this.snapshotKey(tournamentId));
      if (!raw) return null;
      return JSON.parse(raw) as TournamentSnapshot;
    } catch (err) {
      this.logger.warn(`read checkpoint ${tournamentId}: ${(err as Error).message}`);
      return null;
    }
  }

  private async deleteSnapshot(tournamentId: string): Promise<void> {
    try {
      await this.redis.client.del(this.snapshotKey(tournamentId));
    } catch {
      /* best effort - it will expire on its own */
    }
  }
}
