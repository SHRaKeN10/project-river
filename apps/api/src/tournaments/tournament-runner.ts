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
  planBalance,
  prizePool as poolFor,
  seatDraw,
  type TournamentTable,
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
 * The coordinator actor for one running tournament. It owns every table
 * (`Map<tableId, TournamentTableRunner>`) - all in this one API process - and:
 *
 *   - draws seats and stands the tables up with tournament chips as the stack;
 *   - runs the level clock, pushing new blinds into every table between hands;
 *   - relays player actions to the right table;
 *   - after every hand: records bust-outs as `finishPosition` on the
 *     `TournamentEntry`, then runs `planBalance` - breaking short tables and
 *     evening out the rest by moving players between them;
 *   - when one player is left, settles the payout ladder and marks the
 *     tournament `FINISHED`.
 *
 * Conservation invariant: the sum of every entry's stack always equals
 * `startingStack * entrants`.
 *
 * Not yet here (follow-ups): a socket/gateway bridge, hand-for-hand bubble
 * play, chops, antes (the engine doesn't post them), restart recovery.
 */
export class TournamentRunner {
  private readonly logger = new Logger(TournamentRunner.name);
  private readonly tables = new Map<string, TournamentTableRunner>();
  private levelTimer: unknown = null;
  private disposed = false;
  private finishing = false;
  private balancing = false;

  private readonly entries = new Map<string, EntryState>(); // userId -> state
  private eliminatedCount = 0;

  private startedAtMs = 0;
  private schedule: BlindSchedule = [];
  private entrants = 0;
  private startingStack = 0;
  private seatsPerTable = 0;
  private prizePool = 0;

  constructor(
    readonly tournamentId: string,
    private readonly deps: TournamentRunnerDeps,
  ) {}

  get running(): boolean {
    return this.tables.size > 0 && !this.disposed;
  }

  get tableCount(): number {
    return this.tables.size;
  }

  /** Test / diagnostics: every live table's authoritative game state. */
  tableStates(): { tableId: string; state: GameState }[] {
    return [...this.tables.entries()].map(([tableId, t]) => ({ tableId, state: t.gameState }));
  }

  /** Test / diagnostics: how many players are seated at each live table. */
  tableSeatCounts(): number[] {
    return [...this.tables.values()].map((t) => t.seatedUserIds.length);
  }

  /** Test / diagnostics: the first table's state (single-table convenience). */
  get tableState(): GameState | null {
    return [...this.tables.values()][0]?.gameState ?? null;
  }

  /** Test hook: skip the between-hand wait on every table. */
  requestStart(): void {
    for (const t of this.tables.values()) t.requestStart();
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

    this.schedule = row.blindsJson as unknown as BlindSchedule;
    this.entrants = row.entries.length;
    this.startingStack = row.startingStack;
    this.seatsPerTable = row.seatsPerTable;
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
    if (draw.length > 1 && row.seatsPerTable < 3) {
      // Heads-up tables can't be balanced multi-table - any bust leaves an odd
      // live count that needs a one-player table. (A single HU table is fine.)
      throw new Error(
        `a multi-table tournament needs at least three seats per table (got ${row.seatsPerTable})`,
      );
    }
    if (draw.some((t) => t.length < 2)) {
      throw new Error(
        `seats-per-table ${row.seatsPerTable} cannot seat ${this.entrants} entrants without a one-player table`,
      );
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

    const byUser = new Map(row.entries.map((e) => [e.userId, e]));
    draw.forEach((seatArray, tableIndex) => {
      const tableId = `${this.tournamentId}:${tableIndex}`;
      const table = new TournamentTableRunner(tableId, engineConfig, {
        rng: this.deps.rng,
        timers: this.deps.timers,
        now: this.deps.now,
        actionTimeoutMs: this.deps.actionTimeoutMs,
        disconnectGraceMs: this.deps.disconnectGraceMs,
        nextHandDelayMs: this.deps.nextHandDelayMs,
        notify: (n) => this.onTableNotification(tableId, n),
      });
      seatArray.forEach((userId, seatIndex) => {
        const entry = byUser.get(userId);
        if (!entry) throw new Error(`seat draw referenced unknown entrant ${userId}`);
        this.entries.set(userId, {
          entryId: entry.id,
          userId,
          stack: row.startingStack,
          finishPosition: null,
        });
        // Seated optimistically connected; the gateway flips this on real
        // socket join / disconnect (that bridge is a follow-up). Until then a
        // player who never shows is just folded by timeout each hand.
        table.seat({ userId, seat: seatIndex, stack: row.startingStack, connected: true });
      });
      this.tables.set(tableId, table);
    });

    this.startedAtMs = this.deps.now();

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
    for (const t of this.tables.values()) t.start();
    this.logger.log(
      `tournament ${this.tournamentId} started - ${this.entrants} entrants on ${this.tables.size} table(s)`,
    );
  }

  /** Relay a player action to whichever table the player is seated at. */
  act(
    userId: string,
    handId: string,
    clientSeq: number,
    action: Parameters<TournamentTableRunner['submitAction']>[3],
  ): void {
    this.tableOf(userId)?.submitAction(userId, handId, clientSeq, action);
  }

  setConnected(userId: string, connected: boolean): void {
    this.tableOf(userId)?.setConnected(userId, connected);
  }

  dispose(): void {
    this.disposed = true;
    this.clearLevelTimer();
    for (const t of this.tables.values()) t.dispose();
    this.tables.clear();
  }

  // --- clock ----------------------------------------------------------

  private tableOf(userId: string): TournamentTableRunner | undefined {
    for (const t of this.tables.values()) if (t.seatOf(userId) !== null) return t;
    return undefined;
  }

  private clock(): { startedAt: number; pausedMs: number; pausedAt: number | null } {
    return { startedAt: this.startedAtMs, pausedMs: 0, pausedAt: null };
  }

  private applyCurrentLevel(): void {
    if (this.tables.size === 0) return;
    const lvl = currentLevel(this.schedule, this.clock(), this.deps.now());
    for (const t of this.tables.values()) {
      t.setLevel({ smallBlind: lvl.smallBlind, bigBlind: lvl.bigBlind, ante: lvl.ante });
      if (lvl.isBreak) t.pause();
      else t.resume();
    }
  }

  private scheduleLevelAdvance(): void {
    this.clearLevelTimer();
    if (this.disposed || this.tables.size === 0) return;
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

  private onTableNotification(tableId: string, n: TournamentTableNotification): void {
    switch (n.kind) {
      case 'handComplete':
        void this.onHandComplete(tableId, n);
        return;
      case 'idle':
        void this.afterHand();
        return;
      case 'rejected':
        this.logger.debug(`table ${tableId} rejected for ${n.userId}: ${n.code} ${n.reason}`);
        return;
      case 'state':
      case 'events':
        return;
    }
  }

  private async onHandComplete(
    tableId: string,
    n: Extract<TournamentTableNotification, { kind: 'handComplete' }>,
  ): Promise<void> {
    const table = this.tables.get(tableId);

    // --- everything that touches seating happens synchronously, before any
    // await, so a balance triggered by another table's notification can never
    // interleave and see a half-processed hand (a busted player still seated,
    // or a seat freed for a bust not yet recorded).

    // Refresh stacks from the completed hand's own results snapshot - not
    // `table.stacks()`, which by the time this handler runs may already reflect
    // blinds posted for the next hand.
    for (const r of n.results) {
      const entry = this.entries.get(r.userId);
      if (entry && entry.finishPosition === null) entry.stack = r.endStack;
    }

    // Record bust-outs (`busted` is worst-finish-first) and free their seats.
    for (const b of n.busted) {
      const entry = this.entries.get(b.userId);
      if (!entry || entry.finishPosition !== null) continue;
      const position = this.entrants - this.eliminatedCount;
      entry.finishPosition = position;
      entry.stack = 0;
      this.eliminatedCount += 1;
      const seat = table?.seatOf(b.userId);
      if (seat !== null && seat !== undefined) table?.unseat(seat);
      void this.deps.prisma.tournamentEntry
        .update({
          where: { id: entry.entryId },
          data: { stack: 0, eliminatedAt: new Date(), finishPosition: position },
        })
        .catch((err) =>
          this.logger.error(`record elimination ${entry.entryId}: ${(err as Error).message}`),
        );
    }

    await this.persistStacks();
    await this.afterHand();
  }

  /**
   * Post-hand orchestration. `planBalance` needs a consistent, quiescent view,
   * so the real work waits until no table has a hand in progress. Until then,
   * every table that IS between hands is held so it can't run ahead of the
   * laggard - the laggard's own `afterHand` releases everyone.
   */
  private async afterHand(): Promise<void> {
    if (this.balancing || this.disposed || this.finishing) return;

    if ([...this.tables.values()].some((t) => t.handInProgress)) {
      for (const t of this.tables.values()) if (!t.handInProgress) t.holdForBalance();
      return;
    }

    this.balancing = true;
    try {
      this.runBalance();
    } finally {
      this.balancing = false;
    }
    await this.maybeFinish();
  }

  private runBalance(): void {
    this.dropEmptyTables();
    for (const t of this.tables.values()) t.holdForBalance();
    try {
      if (this.tables.size <= 1) return;

      const view: TournamentTable[] = [...this.tables.entries()].map(([id, t]) => ({
        id,
        seats: t.seatsArray(),
      }));
      const plan = planBalance(view, this.seatsPerTable);

      for (const m of plan.moves) {
        const src = this.tables.get(m.from.tableId);
        const dst = this.tables.get(m.to.tableId);
        if (!src || !dst) continue;
        const stack = src.unseat(m.from.seat);
        dst.seat({ userId: m.playerId, seat: m.to.seat, stack, connected: true });
      }

      // A table `planBalance` broke is now empty; dispose it (and any other that
      // emptied). We key on "actually empty", not `breakTableIds`, so a player
      // is never dropped if a move could not be applied.
      this.dropEmptyTables();
    } finally {
      for (const t of this.tables.values()) t.releaseFromBalance();
    }
  }

  private dropEmptyTables(): void {
    for (const [id, t] of [...this.tables]) {
      if (t.seatedUserIds.length === 0) {
        t.dispose();
        this.tables.delete(id);
      }
    }
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
    for (const t of this.tables.values()) t.dispose();
    this.tables.clear();
    this.deps.onFinished?.(this.tournamentId);
  }

  // --- diagnostics --------------------------------------------------

  elapsedMs(): number {
    return elapsedRunningMs(this.clock(), this.deps.now());
  }
}
