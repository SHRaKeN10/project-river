import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { CryptoRandomProvider } from '@river/poker-engine';
import { ChipsService } from '../chips/chips.service';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../infra/prisma/prisma.service';
import { realTimers } from '../tables/table-runner';
import { TournamentRunner } from './tournament-runner';

/**
 * Owns one `TournamentRunner` per running tournament (single-writer actors, the
 * same pattern as `TableManager`). Everything - the coordinator and every one
 * of its tables - lives in this one API process; the deployment must stay at a
 * single machine.
 */
@Injectable()
export class TournamentManager implements OnModuleDestroy {
  private readonly logger = new Logger(TournamentManager.name);
  private readonly runners = new Map<string, TournamentRunner>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly chips: ChipsService,
    private readonly config: AppConfigService,
  ) {}

  onModuleDestroy(): void {
    for (const runner of this.runners.values()) runner.dispose();
    this.runners.clear();
  }

  get(tournamentId: string): TournamentRunner | undefined {
    return this.runners.get(tournamentId);
  }

  /** Stand up the coordinator and start play. Idempotent-ish: a second call
   * while one is already running throws (the caller has a stale view). */
  async start(tournamentId: string): Promise<TournamentRunner> {
    if (this.runners.has(tournamentId)) {
      throw new Error(`tournament ${tournamentId} is already running on this node`);
    }
    const runner = new TournamentRunner(tournamentId, {
      prisma: this.prisma,
      chips: this.chips,
      rng: new CryptoRandomProvider(),
      timers: realTimers,
      now: () => Date.now(),
      actionTimeoutMs: this.config.get('TABLE_ACTION_TIMEOUT_MS'),
      disconnectGraceMs: this.config.get('TABLE_DISCONNECT_GRACE_MS'),
      nextHandDelayMs: this.config.get('TABLE_NEXT_HAND_DELAY_MS'),
      onFinished: (id) => {
        this.runners.get(id)?.dispose();
        this.runners.delete(id);
      },
    });
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
    if (!runner) return;
    runner.dispose();
    this.runners.delete(tournamentId);
    this.logger.log(`stopped tournament ${tournamentId}`);
  }
}
