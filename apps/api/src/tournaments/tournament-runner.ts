import { Logger } from '@nestjs/common';
import { ChipMovementReason } from '@prisma/client';
import {
  type BlindSchedule,
  type GameState,
  type RandomProvider,
  type TableConfig,
  createTableConfig,
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
import { assignRoundPositions, computePayouts } from './standings';
import { currentLevel, elapsedRunningMs, levelEndsAt } from './tournament-clock';
import { type TournamentTableNotification, TournamentTableRunner } from './tournament-table-runner';

/**
 * What the coordinator tells the outside world (the gateway) as a tournament
 * plays. Table state / hand events themselves ride on `tableUpdate`, which
 * carries the raw `TournamentTableNotification` for the gateway to project
 * per-viewer with the same code the cash game uses.
 */
export type TournamentPublicEvent =
  | {
      kind: 'tableUpdate';
      tableId: string;
      notification: Extract<TournamentTableNotification, { kind: 'state' | 'events' | 'rejected' }>;
    }
  /** A player is (re)seated at a table - initial draw, or a balance move. */
  | { kind: 'assigned'; userId: string; tableId: string; seat: number }
  | { kind: 'eliminated'; userId: string; finishPosition: number }
  /** A table dissolved (broke, or the tournament ended). */
  | { kind: 'tableClosed'; tableId: string }
  | { kind: 'finished'; results: { userId: string; position: number; payout: number }[] };

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
  /** Live tournament events for the gateway. Absent in unit tests. */
  publish?: (ev: TournamentPublicEvent) => void;
}

interface EntryState {
  entryId: string;
  userId: string;
  username: string;
  avatarUrl: string | null;
  stack: number;
  finishPosition: number | null;
  /** The table this player currently sits at, or null once eliminated. */
  tableId: string | null;
  /** Set the instant they bust; their finishing position is only assigned once
   * the whole hand-for-hand round closes (`finalizeRound`). */
  pendingBust: { stackAtHandStart: number } | null;
}

/**
 * The coordinator actor for one running tournament. It owns every table
 * (`Map<tableId, TournamentTableRunner>`) - all in this one API process - and:
 *
 *   - draws seats and stands the tables up with tournament chips as the stack;
 *   - runs the level clock, pushing new blinds into every table between hands;
 *   - relays player actions to the right table;
 *   - plays hand-for-hand: every multi-table round is one hand at every live
 *     table, all completed before any table starts the next. Bust-outs are
 *     recorded the instant they happen but their *finishing positions* are
 *     assigned only once the whole round closes, from a single deterministic
 *     sort - so the order in which tables happen to finish can never reorder
 *     the standings (`finalizeRound`);
 *   - then runs `planBalance` - breaking short tables and evening out the rest;
 *   - when one player is left, settles the payout ladder (with exact-tie chops)
 *     and marks the tournament `FINISHED`.
 *
 * Conservation invariant: the sum of every entry's stack always equals
 * `startingStack * entrants`. Payout invariant: the sum of every payout always
 * equals the prize pool.
 *
 * Not yet here (follow-ups): antes (the engine doesn't post them), restart
 * recovery.
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
  /** Monotonic hand-for-hand round counter (one hand at every live table). */
  private roundNumber = 0;
  /** Contiguous position ranges whose prize money is chopped equally, because
   * their players busted the same round with exactly equal covered stacks.
   * e.g. `[[3, 4]]` means positions 3 and 4 split their combined money. */
  private readonly chopGroups: number[][] = [];
  private handForHand = false;

  private startedAtMs = 0;
  private schedule: BlindSchedule = [];
  private entrants = 0;
  private startingStack = 0;
  private seatsPerTable = 0;
  private prizePool = 0;
  private paidPlaces = 1;
  private name = '';
  private gameType = 'NLHE';

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
    this.name = row.name;
    this.gameType = row.gameType;
    this.paidPlaces = this.entrants >= 2 ? placesPaid(this.entrants) : 1;

    const profiles = new Map<string, { username: string; avatarUrl: string | null }>();
    for (const u of await this.deps.prisma.user.findMany({
      where: { id: { in: row.entries.map((e) => e.userId) } },
      select: { id: true, username: true, avatarUrl: true },
    })) {
      profiles.set(u.id, { username: u.username, avatarUrl: u.avatarUrl });
    }
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
      const table = new TournamentTableRunner(
        tableId,
        `${row.name} - Table ${tableIndex + 1}`,
        row.gameType,
        engineConfig,
        {
          rng: this.deps.rng,
          timers: this.deps.timers,
          now: this.deps.now,
          actionTimeoutMs: this.deps.actionTimeoutMs,
          disconnectGraceMs: this.deps.disconnectGraceMs,
          nextHandDelayMs: this.deps.nextHandDelayMs,
          notify: (n) => this.onTableNotification(tableId, n),
        },
      );
      seatArray.forEach((userId, seatIndex) => {
        const entry = byUser.get(userId);
        if (!entry) throw new Error(`seat draw referenced unknown entrant ${userId}`);
        const p = profiles.get(userId) ?? { username: 'player', avatarUrl: null };
        this.entries.set(userId, {
          entryId: entry.id,
          userId,
          username: p.username,
          avatarUrl: p.avatarUrl,
          stack: row.startingStack,
          finishPosition: null,
          tableId,
          pendingBust: null,
        });
        // Seated optimistically connected; the gateway flips this to
        // disconnected when the player's socket actually drops. A player who
        // never shows is folded by timeout each hand.
        table.seat({
          userId,
          username: p.username,
          avatarUrl: p.avatarUrl,
          seat: seatIndex,
          stack: row.startingStack,
          connected: true,
        });
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

    // Tell the gateway where everyone landed.
    for (const e of this.entries.values()) {
      if (e.tableId === null) continue;
      const seat = this.tables.get(e.tableId)?.seatOf(e.userId);
      if (seat !== undefined && seat !== null) {
        this.publish({ kind: 'assigned', userId: e.userId, tableId: e.tableId, seat });
      }
    }

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

  // --- gateway read model -------------------------------------------------

  /** The live table a player currently sits at, or null (spectator/eliminated). */
  tableIdOf(userId: string): string | null {
    return this.entries.get(userId)?.tableId ?? null;
  }

  /** A table for a spectator to watch when they hold no seat - the one with the
   * most players (the "feature" table). Null if the tournament has no tables. */
  spectatorTableId(): string | null {
    let best: string | null = null;
    let bestCount = -1;
    for (const [id, t] of this.tables) {
      const n = t.seatedUserIds.length;
      if (n > bestCount) {
        best = id;
        bestCount = n;
      }
    }
    return best;
  }

  getTable(tableId: string): TournamentTableRunner | undefined {
    return this.tables.get(tableId);
  }

  /** Where a player stands: their table + seat, or their finishing position. */
  entrantView(userId: string): {
    tableId: string | null;
    seat: number | null;
    finishPosition: number | null;
  } | null {
    const e = this.entries.get(userId);
    if (!e) return null;
    const seat = e.tableId ? (this.tables.get(e.tableId)?.seatOf(userId) ?? null) : null;
    return { tableId: e.tableId, seat, finishPosition: e.finishPosition };
  }

  private publish(ev: TournamentPublicEvent): void {
    this.deps.publish?.(ev);
  }

  dispose(): void {
    this.disposed = true;
    this.clearLevelTimer();
    for (const [id, t] of this.tables) {
      t.dispose();
      this.publish({ kind: 'tableClosed', tableId: id });
    }
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
    // Forward the raw table view/events to the gateway - it projects them
    // per-viewer with the same code the cash game uses. `handComplete` / `idle`
    // are internal orchestration signals; the `state` that follows carries the
    // player-visible result.
    if (n.kind === 'state' || n.kind === 'events' || n.kind === 'rejected') {
      this.publish({ kind: 'tableUpdate', tableId, notification: n });
    }

    switch (n.kind) {
      case 'handComplete':
        void this.onHandComplete(tableId, n).catch((err) => this.onOrchestrationError(err));
        return;
      case 'idle':
        void this.afterHand().catch((err) => this.onOrchestrationError(err));
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

    // --- everything that touches seating / eliminations happens synchronously,
    // before any await, so an `afterHand` triggered by another table's
    // notification can never see a half-processed hand.

    // Refresh stacks from the completed hand's own results snapshot - not
    // `table.stacks()`, which by the time this handler runs may already reflect
    // blinds posted for the next hand.
    for (const r of n.results) {
      const entry = this.entries.get(r.userId);
      if (entry && entry.finishPosition === null) entry.stack = r.endStack;
    }

    // Record bust-outs as *pending* - free the seat and zero the stack now, but
    // assign the finishing position only when the whole round closes
    // (`finalizeRound`), from one deterministic sort. Which table's hand
    // finished first must not influence the standings.
    for (const b of n.busted) {
      const entry = this.entries.get(b.userId);
      if (!entry || entry.finishPosition !== null || entry.pendingBust) continue;
      entry.pendingBust = { stackAtHandStart: b.stackAtHandStart };
      entry.stack = 0;
      entry.tableId = null;
      const seat = table?.seatOf(b.userId);
      if (seat !== null && seat !== undefined) table?.unseat(seat);
    }

    await this.persistStacks();
    await this.afterHand();
  }

  /**
   * The round boundary. `planBalance` needs a quiescent view and the standings
   * need one too, so nothing happens until every table has finished this
   * round's hand. Until then, every table that IS between hands is held so it
   * can't run ahead - the laggard's own `afterHand` releases everyone. This is
   * the hand-for-hand rule, and it runs every multi-table round, not just at
   * the bubble.
   */
  private async afterHand(): Promise<void> {
    if (this.balancing || this.disposed || this.finishing) return;

    if ([...this.tables.values()].some((t) => t.handInProgress)) {
      for (const t of this.tables.values()) if (!t.handInProgress) t.holdForBalance();
      return;
    }

    this.balancing = true;
    try {
      this.finalizeRound();
      this.runBalance();
    } finally {
      this.balancing = false;
    }
    await this.maybeFinish();
  }

  private liveCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.finishPosition === null && !e.pendingBust) n += 1;
    return n;
  }

  /** A standings-invariant violation surfaced from `finalizeRound` /
   * `maybeFinish`. These are "wrong payouts" bugs - never continue silently.
   * The tournament stalls (visible, needs a human); in tests the throw fails
   * the test as intended. */
  private onOrchestrationError(err: unknown): void {
    this.logger.error(
      `tournament ${this.tournamentId} orchestration error: ${(err as Error).message}`,
    );
  }

  /**
   * Close the current hand-for-hand round: take every player who busted this
   * round and assign their finishing positions from one deterministic sort
   * (`finishingOrder` - bigger covered stack finishes higher; exact ties fall
   * to player id). Runs only when every table is quiescent, so table-completion
   * order can never reorder the standings. When we are in the money and some of
   * this round's busts tied exactly, their positions' prize money is chopped.
   */
  private finalizeRound(): void {
    const pending = [...this.entries.values()].filter(
      (e) => e.pendingBust !== null && e.finishPosition === null,
    );
    if (pending.length === 0) return;

    this.roundNumber += 1;
    const enteringField = this.liveCount() + pending.length;
    // Hand-for-hand starts (and stays on) once the next round *could* reach the
    // money: with T tables each able to bust at least one, that is when the
    // field entering a round is within `paidPlaces + T`. Chops - a real
    // bubble/ITM concept - only apply while it is on; before that a same-hand
    // tie is just broken deterministically (nobody involved is paid).
    if (!this.handForHand && enteringField <= this.paidPlaces + Math.max(1, this.tables.size)) {
      this.handForHand = true;
      this.logger.log(`tournament ${this.tournamentId}: hand-for-hand near the bubble`);
    }

    const { positions, chopGroups } = assignRoundPositions({
      busts: pending.map((e) => ({
        playerId: e.userId,
        stackAtHandStart: (e.pendingBust as { stackAtHandStart: number }).stackAtHandStart,
      })),
      eliminatedCount: this.eliminatedCount,
      entrants: this.entrants,
      roundNumber: this.roundNumber,
      handForHand: this.handForHand,
      paidPlaces: this.paidPlaces,
    });
    this.chopGroups.push(...chopGroups);

    for (const [pid, position] of positions) {
      const entry = this.entries.get(pid) as EntryState;
      entry.finishPosition = position;
      entry.pendingBust = null;
      this.publish({ kind: 'eliminated', userId: pid, finishPosition: position });
      void this.deps.prisma.tournamentEntry
        .update({
          where: { id: entry.entryId },
          data: { stack: 0, eliminatedAt: new Date(), finishPosition: position },
        })
        .catch((err) =>
          this.logger.error(`record elimination ${entry.entryId}: ${(err as Error).message}`),
        );
    }
    this.eliminatedCount += positions.size;
    this.checkStandings();
  }

  /** Hard invariants on the standings assigned so far. Throws (loud) on a
   * violation - a standings bug means wrong payouts, which must never ship
   * silently. Callers run in a try/catch that logs. */
  private checkStandings(): void {
    const assigned = [...this.entries.values()]
      .map((e) => e.finishPosition)
      .filter((p): p is number => p !== null);
    const set = new Set(assigned);
    if (set.size !== assigned.length) {
      throw new Error(`tournament ${this.tournamentId}: a finishing position was assigned twice`);
    }
    for (const p of assigned) {
      if (p < 1 || p > this.entrants) {
        throw new Error(`tournament ${this.tournamentId}: finishing position ${p} out of range`);
      }
    }
    // Eliminated players fill a contiguous block from `entrants` downward.
    const eliminatedPositions = [...this.entries.values()]
      .filter((e) => e.finishPosition !== null && e.finishPosition !== 1)
      .map((e) => e.finishPosition as number)
      .sort((a, b) => a - b);
    for (let i = 0; i < eliminatedPositions.length; i += 1) {
      const expected = this.entrants - eliminatedPositions.length + 1 + i;
      if (eliminatedPositions[i] !== expected) {
        throw new Error(
          `tournament ${this.tournamentId}: eliminated positions not contiguous (${eliminatedPositions.join(',')})`,
        );
      }
    }
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
        const moved = src.unseat(m.from.seat);
        if (!moved) continue;
        dst.seat({
          userId: moved.userId,
          username: moved.username,
          avatarUrl: moved.avatarUrl,
          seat: m.to.seat,
          stack: moved.stack,
          connected: moved.connected,
        });
        const entry = this.entries.get(moved.userId);
        if (entry) entry.tableId = m.to.tableId;
        this.publish({
          kind: 'assigned',
          userId: moved.userId,
          tableId: m.to.tableId,
          seat: m.to.seat,
        });
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
        this.publish({ kind: 'tableClosed', tableId: id });
      }
    }
  }

  private async persistStacks(): Promise<void> {
    await Promise.all(
      [...this.entries.values()]
        .filter((e) => e.finishPosition === null && e.pendingBust === null)
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
    const live = [...this.entries.values()].filter(
      (e) => e.finishPosition === null && e.pendingBust === null,
    );
    if (live.length > 1) return;
    this.finishing = true;

    const winner = live[0];
    if (winner) {
      winner.finishPosition = 1;
      winner.stack = this.startingStack * this.entrants;
    }
    this.checkStandings();

    // Compute the whole payout table and verify it *before* moving any chips,
    // so a standings/chop bug can never half-pay a tournament.
    const payoutByPos = computePayouts(this.entrants, this.prizePool, this.chopGroups);
    const ordered = [...this.entries.values()].sort(
      (a, b) => (a.finishPosition ?? 0) - (b.finishPosition ?? 0),
    );
    const results = ordered.map((e) => {
      const position = e.finishPosition ?? this.entrants;
      return {
        userId: e.userId,
        entryId: e.entryId,
        position,
        payout: payoutByPos.get(position) ?? 0,
      };
    });
    const paidOut = results.reduce((s, r) => s + r.payout, 0);
    if (paidOut !== this.prizePool) {
      this.finishing = false;
      throw new Error(
        `tournament ${this.tournamentId}: payouts ${paidOut} != prize pool ${this.prizePool}`,
      );
    }

    for (const r of results) {
      if (r.payout > 0) {
        await this.deps.chips
          .move({
            userId: r.userId,
            amount: r.payout,
            reason: ChipMovementReason.TOURNAMENT_PAYOUT,
            idemKey: `tpay:${r.entryId}`,
          })
          .catch((err) =>
            this.logger.error(`payout ${r.entryId} (+${r.payout}): ${(err as Error).message}`),
          );
      }
      await this.deps.prisma.tournamentEntry
        .update({
          where: { id: r.entryId },
          data: {
            payout: r.payout,
            finishPosition: r.position,
            stack: this.entries.get(r.userId)?.stack ?? 0,
            // The winner is not "eliminated"; everyone else already has their
            // eliminatedAt from the hand they busted.
            eliminatedAt: r.position === 1 ? null : undefined,
          },
        })
        .catch(() => undefined);
    }

    const standings = results.map((r) => ({
      userId: r.userId,
      position: r.position,
      payout: r.payout,
    }));
    await this.deps.prisma.tournament.update({
      where: { id: this.tournamentId },
      data: {
        status: 'FINISHED',
        finishedAt: new Date(),
        resultsJson: standings as unknown as object[],
      },
    });

    this.logger.log(
      `tournament ${this.tournamentId} finished - winner ${winner?.userId ?? '?'} (+${standings[0]?.payout ?? 0})`,
    );
    this.clearLevelTimer();
    for (const e of this.entries.values()) e.tableId = null;
    for (const [id, t] of this.tables) {
      t.dispose();
      this.publish({ kind: 'tableClosed', tableId: id });
    }
    this.tables.clear();
    this.publish({ kind: 'finished', results: standings });
    this.deps.onFinished?.(this.tournamentId);
  }

  // --- diagnostics --------------------------------------------------

  elapsedMs(): number {
    return elapsedRunningMs(this.clock(), this.deps.now());
  }
}
