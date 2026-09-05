import { randomUUID } from 'node:crypto';
import { Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { ChipMovementReason, Prisma } from '@prisma/client';
import {
  CryptoRandomProvider,
  createTableConfig,
  type GameState,
  type PreviousPositions,
} from '@river/poker-engine';
import { ChipsService } from '../chips/chips.service';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../infra/prisma/prisma.service';
import { RedisService } from '../infra/redis/redis.service';
import { variantForGameType } from './game-variant';
import { type RunnerNotification, TableRunner, realTimers } from './table-runner';
import type { TableMeta } from './table-projection';
import { TablesService } from './tables.service';

const SNAPSHOT_TTL_SECONDS = 2 * 60 * 60;

type ManagerListener = (
  tableId: string,
  notification: RunnerNotification,
  runner: TableRunner,
) => void;

interface Snapshot {
  state: GameState;
  handNumber: number;
  previousPositions: PreviousPositions | null;
  roster: {
    seatNumber: number;
    userId: string;
    username: string;
    avatarUrl: string | null;
    stack: number;
    sittingOut: boolean;
  }[];
}

/**
 * Owns one `TableRunner` per active table (single-writer actors). All the
 * gateway does is look a runner up, push a command, and forward its
 * notifications on to sockets.
 */
@Injectable()
export class TableManager implements OnModuleDestroy {
  private readonly logger = new Logger(TableManager.name);
  private readonly runners = new Map<string, TableRunner>();
  private readonly creating = new Map<string, Promise<TableRunner>>();
  private readonly listeners = new Set<ManagerListener>();
  /** In-flight writes to a table's PokerTableSeat rows (cash-outs + roster
   * snapshots). A rejoin or a table close waits these out so it can't race a
   * seat row the runner is still persisting. */
  private readonly pendingSeatWrites = new Map<string, Set<Promise<unknown>>>();
  /** Pending idle-runner reaps. An empty table is dropped after a grace delay,
   * not synchronously - a synchronous drop could dispose a runner a concurrent
   * join is mid-way through seating into. Any `getOrCreate` cancels it. */
  private readonly reapTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly tables: TablesService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
    private readonly chips: ChipsService,
  ) {}

  onModuleDestroy(): void {
    for (const t of this.reapTimers.values()) clearTimeout(t);
    this.reapTimers.clear();
    for (const runner of this.runners.values()) runner.dispose();
    this.runners.clear();
  }

  subscribe(listener: ManagerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRunner(tableId: string): TableRunner | undefined {
    return this.runners.get(tableId);
  }

  /** Whether an emptied runner is waiting out its grace delay before being
   * dropped. Test / diagnostics. */
  isIdleReapScheduled(tableId: string): boolean {
    return this.reapTimers.has(tableId);
  }

  /** Point-in-time counts for the ops /metrics endpoint. A "stuck" table has a
   * hand whose action clock lapsed well past when its timer should have fired -
   * a sign the runner queue wedged and needs a look. */
  liveMetrics(now: number = Date.now()): {
    activeTables: number;
    seatedPlayers: number;
    handsInProgress: number;
    stuckTables: number;
  } {
    let seatedPlayers = 0;
    let handsInProgress = 0;
    let stuckTables = 0;
    for (const runner of this.runners.values()) {
      seatedPlayers += runner.seatedCount;
      if (!runner.handInProgress) continue;
      handsInProgress += 1;
      const deadline = runner.gameState.actionDeadline;
      if (deadline !== null && now - deadline > 30_000) stuckTables += 1;
    }
    return { activeTables: this.runners.size, seatedPlayers, handsInProgress, stuckTables };
  }

  async getOrCreate(tableId: string): Promise<TableRunner> {
    // Anyone asking for this table cancels a pending reap - a join is in flight.
    this.cancelReap(tableId);
    const existing = this.runners.get(tableId);
    if (existing) return existing;
    const pending = this.creating.get(tableId);
    if (pending) return pending;

    const promise = this.build(tableId).finally(() => this.creating.delete(tableId));
    this.creating.set(tableId, promise);
    return promise;
  }

  /** Tear a table's live runner down and return every seated stack to its
   * wallet. Called when an admin closes the table. */
  async closeTable(tableId: string): Promise<void> {
    this.cancelReap(tableId);
    const runner = this.runners.get(tableId);
    if (!runner) return;
    this.runners.delete(tableId);
    runner.dispose();
    // Let any in-flight roster snapshot land first, then cash every seat out.
    await this.settleSeatChanges(tableId);
    for (const [seat, entry] of runner.rosterEntries) {
      this.trackSeatWrite(
        tableId,
        this.cashOut(tableId, seat, entry.userId, entry.stack, `close:${randomUUID()}`),
      );
    }
    await this.settleSeatChanges(tableId);
    // Belt and braces: the table is gone, so force every seat row empty.
    await this.prisma.pokerTableSeat
      .updateMany({
        where: { tableId },
        data: { userId: null, stack: 0, sittingOut: false, joinedAt: null },
      })
      .catch((err) =>
        this.logger.error(`closeTable cleanup ${tableId}: ${(err as Error).message}`),
      );
  }

  private static readonly REAP_GRACE_MS = 20_000;

  private cancelReap(tableId: string): void {
    const t = this.reapTimers.get(tableId);
    if (t) {
      clearTimeout(t);
      this.reapTimers.delete(tableId);
    }
  }

  /** Schedule a drop of an emptied runner after a grace delay, so idle tables
   * don't pile up in memory. Deferred (not synchronous) so a join that already
   * holds this runner reference can finish seating before it's disposed; any
   * `getOrCreate` in the meantime cancels it. Rebuilds lazily on the next visit. */
  private reapIfIdle(tableId: string, runner: TableRunner): void {
    if (this.runners.get(tableId) !== runner) return;
    if (!runner.isEmpty() || runner.handInProgress) {
      this.cancelReap(tableId);
      return;
    }
    if (this.reapTimers.has(tableId)) return;
    const timer = setTimeout(() => {
      this.reapTimers.delete(tableId);
      const r = this.runners.get(tableId);
      if (r !== runner || !r.isEmpty() || r.handInProgress) return;
      this.runners.delete(tableId);
      r.dispose();
      this.logger.debug(`reaped idle runner ${tableId}`);
    }, TableManager.REAP_GRACE_MS);
    timer.unref?.();
    this.reapTimers.set(tableId, timer);
  }

  private async build(tableId: string): Promise<TableRunner> {
    const table = await this.tables.get(tableId);
    if (table.status === 'CLOSED') {
      // A closed table has no live game - the gateway turns this into an error.
      throw new NotFoundException('table is closed');
    }
    const meta: TableMeta = {
      id: table.id,
      name: table.name,
      gameType: table.gameType,
      smallBlind: table.smallBlind,
      bigBlind: table.bigBlind,
      maxSeats: table.maxSeats,
      minBuyIn: table.minBuyIn,
      maxBuyIn: table.maxBuyIn,
      timeChargeAmount: table.timeChargeAmount,
      timeChargeIntervalMs: table.timeChargeIntervalMs,
    };
    const engineConfig = createTableConfig({
      variant: variantForGameType(table.gameType),
      smallBlind: table.smallBlind,
      bigBlind: table.bigBlind,
      ante: table.ante,
      maxSeats: table.maxSeats,
      minBuyIn: table.minBuyIn,
      maxBuyIn: table.maxBuyIn,
    });

    const runner = new TableRunner(meta, engineConfig, {
      rng: new CryptoRandomProvider(),
      timers: realTimers,
      now: () => Date.now(),
      config: {
        actionTimeoutMs: this.config.get('TABLE_ACTION_TIMEOUT_MS'),
        nextHandDelayMs: this.config.get('TABLE_NEXT_HAND_DELAY_MS'),
        startDelayMs: this.config.get('TABLE_START_DELAY_MS'),
        disconnectGraceMs: this.config.get('TABLE_DISCONNECT_GRACE_MS'),
        awayMaxMs: this.config.get('TABLE_AWAY_MAX_MS'),
        awayMaxMissedHands: this.config.get('TABLE_AWAY_MAX_MISSED_HANDS'),
      },
      notify: (notification) => {
        this.emit(tableId, notification, runner);
        void this.persistSnapshot(tableId, runner);
      },
      persistRoster: (r) => {
        // Tracked like a vacate so `settleSeatChanges` also waits out a lagging
        // roster snapshot - otherwise a late syncSeats can clobber a standUp.
        this.trackSeatWrite(
          tableId,
          this.tables
            .syncSeats(tableId, r.rosterSnapshot(), r.lastHandNumber, r.lastPositions)
            .catch((err) => this.logger.error(`syncSeats ${tableId}: ${(err as Error).message}`)),
        );
      },
      onSeatVacated: ({ userId, seatNumber, stack, idemKey }) => {
        this.trackSeatWrite(tableId, this.cashOut(tableId, seatNumber, userId, stack, idemKey));
        this.emit(tableId, { kind: 'seatVacated' }, runner);
        this.reapIfIdle(tableId, runner);
      },
      recordHandStats: (potTotal) => {
        void this.prisma.pokerTable
          .update({
            where: { id: tableId },
            data: { handsPlayed: { increment: 1 }, potSum: { increment: potTotal } },
          })
          .catch((err) => this.logger.warn(`stats ${tableId}: ${(err as Error).message}`));
      },
      recordHand: (hand) => {
        void this.prisma.pokerHand
          .create({
            data: {
              tableId,
              handNumber: hand.handNumber,
              engineHandId: hand.engineHandId,
              deck: hand.deck,
              buttonSeat: hand.buttonSeat,
              smallBlindSeat: hand.smallBlindSeat,
              bigBlindSeat: hand.bigBlindSeat,
              prevPositionsJson:
                hand.prevPositions === null
                  ? undefined
                  : (hand.prevPositions as unknown as Prisma.InputJsonValue),
              seatsJson: hand.seats as unknown as Prisma.InputJsonValue,
              actionsJson: hand.actions as unknown as Prisma.InputJsonValue,
              board: hand.board,
              resultsJson: hand.results as unknown as Prisma.InputJsonValue,
              potTotal: hand.potTotal,
              userIds: [...new Set(hand.seats.map((s) => s.userId))],
              startedAt: new Date(hand.startedAt),
              endedAt: new Date(hand.endedAt),
            },
          })
          .catch((err) =>
            this.logger.warn(`recordHand ${tableId}#${hand.handNumber}: ${(err as Error).message}`),
          );
      },
      chargeAccount: ({ userId, amount, idemKey }) => {
        void this.chips
          .move({
            userId,
            amount: -amount,
            reason: ChipMovementReason.TABLE_TIME_CHARGE,
            idemKey,
            tableId,
          })
          .catch((err) =>
            this.logger.warn(
              `time charge ${userId} (-${amount}) at ${tableId}: ${(err as Error).message}`,
            ),
          );
      },
    });

    await this.hydrate(runner, table);
    this.runners.set(tableId, runner);
    return runner;
  }

  private async hydrate(
    runner: TableRunner,
    table: Awaited<ReturnType<TablesService['get']>>,
  ): Promise<void> {
    const snapshot = await this.readSnapshot(table.id);
    const seatUserIds = (snapshot?.roster.map((r) => r.userId) ??
      table.seats.filter((s) => s.userId).map((s) => s.userId as string)) as string[];

    const users = await this.prisma.user.findMany({
      where: { id: { in: seatUserIds } },
      select: { id: true, username: true, avatarUrl: true },
    });
    const userMeta = new Map(
      users.map((u) => [u.id, { username: u.username, avatarUrl: u.avatarUrl }]),
    );

    if (snapshot) {
      runner.hydrateFromSnapshot(snapshot, userMeta);
    } else {
      runner.hydrate(
        table.seats.map((s) => ({
          seatNumber: s.seatNumber,
          userId: s.userId,
          stack: s.stack,
          sittingOut: s.sittingOut,
        })),
        userMeta,
        table.handNumber,
        table.buttonSeat === null
          ? null
          : {
              buttonSeat: table.buttonSeat,
              smallBlindSeat: table.smallBlindSeat,
              bigBlindSeat: table.bigBlindSeat ?? table.buttonSeat,
            },
      );
    }
  }

  private trackSeatWrite(tableId: string, work: Promise<unknown>): void {
    let set = this.pendingSeatWrites.get(tableId);
    if (!set) {
      set = new Set();
      this.pendingSeatWrites.set(tableId, set);
    }
    const wrapped = work.finally(() => set?.delete(wrapped));
    set.add(wrapped);
  }

  /** Resolves once every in-flight seat cash-out for the table has committed. A
   * rejoin awaits this so its DB `already seated` guard isn't tripped by a seat
   * row the player is still in the middle of leaving. */
  async settleSeatChanges(tableId: string): Promise<void> {
    const set = this.pendingSeatWrites.get(tableId);
    if (!set || set.size === 0) return;
    await Promise.allSettled([...set]);
  }

  /** Return a stood-up player's stack to their wallet. Idempotent on `idemKey`,
   * so a few retries after a transient DB failure are safe. */
  private async cashOut(
    tableId: string,
    seatNumber: number,
    userId: string,
    stack: number,
    idemKey: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await this.tables.standUp({ tableId, seatNumber, userId, finalStack: stack, idemKey });
        return;
      } catch (err) {
        this.logger.error(
          `cashOut ${userId} (+${stack}) attempt ${attempt + 1}: ${(err as Error).message}`,
        );
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    this.logger.error(
      `cashOut FAILED for ${userId} (+${stack}) at table ${tableId} - manual reconciliation needed (idemKey ${idemKey})`,
    );
  }

  private emit(tableId: string, notification: RunnerNotification, runner: TableRunner): void {
    for (const listener of this.listeners) {
      try {
        listener(tableId, notification, runner);
      } catch (err) {
        this.logger.error(`listener error: ${(err as Error).message}`);
      }
    }
  }

  private async persistSnapshot(tableId: string, runner: TableRunner): Promise<void> {
    try {
      const snapshot: Snapshot = {
        state: runner.gameState,
        handNumber: runner.lastHandNumber,
        previousPositions: runner.lastPositions,
        roster: [...runner.rosterEntries.entries()].map(([seatNumber, e]) => ({
          seatNumber,
          userId: e.userId,
          username: e.username,
          avatarUrl: e.avatarUrl,
          stack: e.stack,
          sittingOut: e.sittingOut,
        })),
      };
      await this.redis.client.set(
        this.snapshotKey(tableId),
        JSON.stringify(snapshot),
        'EX',
        SNAPSHOT_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.warn(`snapshot ${tableId}: ${(err as Error).message}`);
    }
  }

  private async readSnapshot(tableId: string): Promise<Snapshot | null> {
    try {
      const raw = await this.redis.client.get(this.snapshotKey(tableId));
      return raw ? (JSON.parse(raw) as Snapshot) : null;
    } catch {
      return null;
    }
  }

  private snapshotKey(tableId: string): string {
    return `table:${tableId}:snapshot`;
  }
}
