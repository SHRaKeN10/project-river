import { Logger } from '@nestjs/common';
import { ChipMovementReason } from '@prisma/client';
import {
  type BlindSchedule,
  type GameState,
  type RandomProvider,
  type TableConfig,
  createTableConfig,
  payoutSchedule,
  placesPaid,
  prizePool as poolFor,
  seatDraw,
} from '@river/poker-engine';
import { ChipsService } from '../chips/chips.service';
import { PrismaService } from '../infra/prisma/prisma.service';
import { variantForGameType } from '../tables/game-variant';
import { type TimerScheduler } from '../tables/table-runner';
import { currentLevel, elapsedRunningMs, levelEndsAt } from './tournament-clock';
import { type TournamentTableNotification, TournamentTableRunner } from './tournament-table-runner';

export interface TournamentRunnerDeps {
  prisma: PrismaService;
  chips: ChipsService;
  rng: RandomProvider;
  timers: TimerScheduler;
  now: () => number;
  actionTimeoutMs: number;
  disconnectGraceMs: number;
  nextHandDelayMs: number;
  /** Called when the tournament reaches `FINISHED` (or is torn down). */
  onFinished?: (tournamentId: string) => void;
}

interface EntryState {
  entryId: string;
  userId: string;
  stack: number;
  finishPosition: number | null;
}

/**
 * The coordinator actor for one running tournament. This first cut runs a
 * **single table** (`entrants <= seatsPerTable`); multi-table seating and
 * `planBalance` follow in the next PR.
 *
 * Responsibilities:
 *   - draw seats and stand the table up with tournament chips as the stack;
 *   - run the level clock, pushing new blinds into the table between hands;
 *   - relay player actions to the table;
 *   - watch every completed hand for bust-outs, record `finishPosition` on the
 *     `TournamentEntry`, and keep the persisted stacks current;
 *   - when one player is left, settle the payout ladder against wallets and
 *     mark the tournament `FINISHED`.
 *
 * Conservation invariant: the sum of every live entry's stack always equals
 * `startingStack * entrants`.
 */
export class TournamentRunner {
  private readonly logger = new Logger(TournamentRunner.name);
  private table: TournamentTableRunner | null = null;
  private levelTimer: unknown = null;
  private disposed = false;
  private finishing = false;

  private readonly entries = new Map<string, EntryState>(); // userId -> state
  private eliminatedCount = 0;

  private startedAtMs = 0;
  private schedule: BlindSchedule = [];
  private entrants = 0;
  private startingStack = 0;
  private prizePool = 0;

  constructor(
    readonly tournamentId: string,
    private readonly deps: TournamentRunnerDeps,
  ) {}

  get running(): boolean {
    return this.table !== null && !this.disposed;
  }

  /** Test / diagnostics: the live table's authoritative game state, or null. */
  get tableState(): GameState | null {
    return this.table?.gameState ?? null;
  }

  /** Test / diagnostics: advance the table to its next hand without the wait. */
  forceNextHand(): void {
    this.table?.requestStart();
  }

  /** userId -> current stack (live entries only). Test / diagnostics. */
  stacks(): Map<string, number> {
    const out = new Map<string, number>();
    for (const e of this.entries.values())
      if (e.finishPosition === null) out.set(e.userId, e.stack);
    return out;
  }

  get totalChips(): number {
    let sum = 0;
    for (const e of this.entries.values()) sum += e.stack;
    return sum;
  }

  // --- lifecycle -------------------------------------------------------

  async start(): Promise<void> {
    const row = await this.deps.prisma.tournament.findUniqueOrThrow({
      where: { id: this.tournamentId },
      include: { entries: { orderBy: { registeredAt: 'asc' } } },
    });
    if (row.status === 'RUNNING') {
      throw new Error(`tournament ${this.tournamentId} is already running`);
    }
    if (row.status !== 'SCHEDULED' && row.status !== 'REGISTERING') {
      throw new Error(`cannot start a ${row.status} tournament`);
    }
    if (row.entries.length < 2) throw new Error('a tournament needs at least two entrants');
    if (row.entries.length > row.seatsPerTable) {
      throw new Error(
        `multi-table tournaments are not supported yet (${row.entries.length} entrants, ${row.seatsPerTable} seats per table)`,
      );
    }

    this.schedule = row.blindsJson as unknown as BlindSchedule;
    this.entrants = row.entries.length;
    this.startingStack = row.startingStack;
    this.prizePool = poolFor(
      {
        variant: variantForGameType(row.gameType),
        buyIn: row.buyIn,
        entryFee: row.entryFee,
        startingStack: row.startingStack,
        seatsPerTable: row.seatsPerTable,
        blinds: this.schedule,
        lateRegUntilLevel: row.lateRegUntilLevel,
        maxEntrants: row.maxEntrants,
      },
      this.entrants,
    );

    const draw = seatDraw(
      row.entries.map((e) => e.userId),
      row.seatsPerTable,
      this.deps.rng,
    );
    const table0 = draw[0];
    if (draw.length !== 1 || !table0) {
      throw new Error('single-table seat draw expected exactly one table');
    }

    const level1 = this.schedule[0];
    if (!level1) throw new Error('blind schedule is empty');
    const engineConfig: TableConfig = createTableConfig({
      variant: variantForGameType(row.gameType),
      smallBlind: level1.smallBlind,
      bigBlind: level1.bigBlind,
      ante: level1.ante,
      maxSeats: row.seatsPerTable,
      minBuyIn: row.startingStack,
      maxBuyIn: row.startingStack,
    });

    const table = new TournamentTableRunner(`${this.tournamentId}:0`, engineConfig, {
      rng: this.deps.rng,
      timers: this.deps.timers,
      now: this.deps.now,
      actionTimeoutMs: this.deps.actionTimeoutMs,
      disconnectGraceMs: this.deps.disconnectGraceMs,
      nextHandDelayMs: this.deps.nextHandDelayMs,
      notify: (n) => this.onTableNotification(n),
    });

    const byUser = new Map(row.entries.map((e) => [e.userId, e]));
    table0.forEach((userId, seatIndex) => {
      const entry = byUser.get(userId);
      if (!entry) throw new Error(`seat draw referenced unknown entrant ${userId}`);
      this.entries.set(userId, {
        entryId: entry.id,
        userId,
        stack: row.startingStack,
        finishPosition: null,
      });
      // Seated optimistically connected; the gateway flips this on real socket
      // join / disconnect. Until that lands, a player who never shows just gets
      // the full action clock and is folded by timeout each hand.
      table.seat({ userId, seat: seatIndex, stack: row.startingStack, connected: true });
    });

    this.startedAtMs = this.deps.now();
    this.table = table;

    await this.deps.prisma.tournament.update({
      where: { id: this.tournamentId },
      data: {
        status: 'RUNNING',
        startedAt: new Date(this.startedAtMs),
        pausedMs: 0,
        pausedAt: null,
      },
    });
    await this.persistStacks();

    this.scheduleLevelAdvance();
    table.start();
    this.logger.log(`tournament ${this.tournamentId} started with ${this.entrants} entrants`);
  }

  /** Relay a player action to the table. */
  act(
    userId: string,
    handId: string,
    clientSeq: number,
    action: Parameters<TournamentTableRunner['submitAction']>[3],
  ): void {
    this.table?.submitAction(userId, handId, clientSeq, action);
  }

  setConnected(userId: string, connected: boolean): void {
    this.table?.setConnected(userId, connected);
  }

  /** Test hook: force the first hand without waiting out `nextHandDelayMs`. */
  requestStart(): void {
    this.table?.requestStart();
  }

  dispose(): void {
    this.disposed = true;
    this.clearLevelTimer();
    this.table?.dispose();
    this.table = null;
  }

  // --- clock ----------------------------------------------------------

  private clock(): { startedAt: number; pausedMs: number; pausedAt: number | null } {
    return { startedAt: this.startedAtMs, pausedMs: 0, pausedAt: null };
  }

  private applyCurrentLevel(): void {
    if (!this.table) return;
    const lvl = currentLevel(this.schedule, this.clock(), this.deps.now());
    this.table.setLevel({ smallBlind: lvl.smallBlind, bigBlind: lvl.bigBlind, ante: lvl.ante });
    if (lvl.isBreak) this.table.pause();
    else this.table.resume();
  }

  private scheduleLevelAdvance(): void {
    this.clearLevelTimer();
    if (this.disposed || !this.table) return;
    this.applyCurrentLevel();
    const endsAt = levelEndsAt(this.schedule, this.clock(), this.deps.now());
    if (endsAt === null) return; // on the final level - nothing more to schedule
    const delay = Math.max(0, endsAt - this.deps.now());
    this.levelTimer = this.deps.timers.set(() => {
      this.levelTimer = null;
      this.scheduleLevelAdvance();
    }, delay);
  }

  private clearLevelTimer(): void {
    if (this.levelTimer !== null) {
      this.deps.timers.clear(this.levelTimer);
      this.levelTimer = null;
    }
  }

  // --- table notifications ------------------------------------------

  private onTableNotification(n: TournamentTableNotification): void {
    switch (n.kind) {
      case 'handComplete':
        void this.onHandComplete(n);
        return;
      case 'idle':
        void this.maybeFinish();
        return;
      case 'rejected':
        this.logger.debug(`table rejected for ${n.userId}: ${n.code} ${n.reason}`);
        return;
      case 'state':
      case 'events':
        return;
    }
  }

  private async onHandComplete(
    n: Extract<TournamentTableNotification, { kind: 'handComplete' }>,
  ): Promise<void> {
    // Refresh stacks from the completed hand's own results snapshot - not
    // `table.stacks()`, which by the time this async handler runs may already
    // reflect blinds posted for the next hand.
    for (const r of n.results) {
      const entry = this.entries.get(r.userId);
      if (entry && entry.finishPosition === null) entry.stack = r.endStack;
    }

    // Record bust-outs. `busted` is already worst-finish-first.
    for (const b of n.busted) {
      const entry = this.entries.get(b.userId);
      if (!entry || entry.finishPosition !== null) continue;
      const position = this.entrants - this.eliminatedCount;
      entry.finishPosition = position;
      entry.stack = 0;
      this.eliminatedCount += 1;
      // Free the seat now that the elimination is recorded.
      const seat = this.table?.seatOf(b.userId);
      if (seat !== null && seat !== undefined) this.table?.unseat(seat);
      await this.deps.prisma.tournamentEntry
        .update({
          where: { id: entry.entryId },
          data: { stack: 0, eliminatedAt: new Date(), finishPosition: position },
        })
        .catch((err) =>
          this.logger.error(`record elimination ${entry.entryId}: ${(err as Error).message}`),
        );
    }

    await this.persistStacks();
    await this.maybeFinish();
  }

  private async persistStacks(): Promise<void> {
    await Promise.all(
      [...this.entries.values()]
        .filter((e) => e.finishPosition === null)
        .map((e) =>
          this.deps.prisma.tournamentEntry
            .update({ where: { id: e.entryId }, data: { stack: e.stack } })
            .catch((err) =>
              this.logger.warn(`persist stack ${e.entryId}: ${(err as Error).message}`),
            ),
        ),
    );
  }

  private async maybeFinish(): Promise<void> {
    if (this.finishing || this.disposed) return;
    const live = [...this.entries.values()].filter((e) => e.finishPosition === null);
    if (live.length > 1) return;
    this.finishing = true;

    const winner = live[0];
    if (winner) {
      winner.finishPosition = 1;
      winner.stack = this.startingStack * this.entrants;
    }

    const ladder = payoutSchedule(this.entrants, this.prizePool);
    const paidPlaces = this.entrants >= 2 ? placesPaid(this.entrants) : 1;

    const ordered = [...this.entries.values()].sort(
      (a, b) => (a.finishPosition ?? 0) - (b.finishPosition ?? 0),
    );
    const results: { userId: string; position: number; payout: number }[] = [];
    for (const e of ordered) {
      const position = e.finishPosition ?? this.entrants;
      const payout = position <= paidPlaces ? (ladder[position - 1] ?? 0) : 0;
      results.push({ userId: e.userId, position, payout });
      if (payout > 0) {
        await this.deps.chips
          .move({
            userId: e.userId,
            amount: payout,
            reason: ChipMovementReason.TOURNAMENT_PAYOUT,
            idemKey: `tpay:${e.entryId}`,
          })
          .catch((err) =>
            this.logger.error(`payout ${e.entryId} (+${payout}): ${(err as Error).message}`),
          );
      }
      await this.deps.prisma.tournamentEntry
        .update({
          where: { id: e.entryId },
          data: {
            payout,
            finishPosition: position,
            stack: e.stack,
            // The winner is not "eliminated"; everyone else already has their
            // eliminatedAt from the hand they busted.
            eliminatedAt: position === 1 ? null : undefined,
          },
        })
        .catch(() => undefined);
    }

    await this.deps.prisma.tournament.update({
      where: { id: this.tournamentId },
      data: {
        status: 'FINISHED',
        finishedAt: new Date(),
        resultsJson: results as unknown as object[],
      },
    });

    this.logger.log(
      `tournament ${this.tournamentId} finished - winner ${winner?.userId ?? '?'} (+${results[0]?.payout ?? 0})`,
    );
    this.clearLevelTimer();
    this.table?.dispose();
    this.table = null;
    this.deps.onFinished?.(this.tournamentId);
  }

  // --- diagnostics --------------------------------------------------

  elapsedMs(): number {
    return elapsedRunningMs(this.clock(), this.deps.now());
  }
}
