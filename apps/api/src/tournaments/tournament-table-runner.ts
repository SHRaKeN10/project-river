import { randomUUID } from 'node:crypto';
import {
  type EngineAction,
  type GameEvent,
  type GameState,
  type PlayerAction,
  PlayerStatus,
  type PreviousPositions,
  type RandomProvider,
  Street,
  type TableConfig,
  initGameState,
  previousPositionsOf,
  reduce,
} from '@river/poker-engine';
import { type TimerScheduler } from '../tables/table-runner';

/**
 * One tournament table = one single-writer actor, the same shape as the cash
 * game's `TableRunner` but tournament-flavoured:
 *
 *   - seats are assigned by the coordinator, never bought in to; a busted stack
 *     is *not* returned to a wallet, it is simply gone;
 *   - blinds change between hands as the level clock advances (`setLevel`);
 *   - a disconnected player is blinded/timed off, never stood up - you only
 *     leave a tournament by busting.
 *
 * It owns the authoritative `GameState`; the coordinator relays actions in and
 * listens for `handComplete` / `idle`.
 */

export interface TournamentHandResult {
  seat: number;
  userId: string;
  stackAtHandStart: number;
  endStack: number;
  net: number;
}

export type TournamentTableNotification =
  | { kind: 'state' }
  | { kind: 'events'; events: GameEvent[] }
  | { kind: 'rejected'; userId: string; code: string; reason: string }
  | {
      kind: 'handComplete';
      handNumber: number;
      results: TournamentHandResult[];
      /** Seats whose stack hit zero this hand, worst-finish first (smallest
       * stack at the start of the hand busts "first"). */
      busted: { seat: number; userId: string; stackAtHandStart: number }[];
    }
  /** Fewer than two players have chips, or the table is paused - no next hand
   * was scheduled. The coordinator decides what happens next (final table over,
   * balance players in, resume). */
  | { kind: 'idle' };

export interface TournamentTableDeps {
  rng: RandomProvider;
  timers: TimerScheduler;
  now: () => number;
  actionTimeoutMs: number;
  /** Shorter clock for a disconnected player who is holding up the table. */
  disconnectGraceMs: number;
  nextHandDelayMs: number;
  notify: (n: TournamentTableNotification) => void;
}

interface SeatEntry {
  userId: string;
  connected: boolean;
  stack: number;
}

type Command =
  | { type: 'START_HAND' }
  | { type: 'ACTION'; userId: string; handId: string; clientSeq: number; action: PlayerAction }
  | { type: 'TIMEOUT'; seat: number; handId: string };

export class TournamentTableRunner {
  private state: GameState;
  private engineConfig: TableConfig;
  /** Blinds/ante for the *next* hand, applied at START_HAND. */
  private pendingConfig: TableConfig;
  private readonly roster = new Map<number, SeatEntry>();
  private readonly queue: Command[] = [];
  private draining = false;

  private handNumber = 0;
  private previousPositions: PreviousPositions | null = null;
  private readonly lastSeqByUser = new Map<string, number>();

  private actionTimer: unknown = null;
  private nextHandTimer: unknown = null;
  /** Paused by a scheduled break. */
  private paused = false;
  /** Held by the coordinator while it rearranges seating between hands. */
  private held = false;
  private disposed = false;
  /** Stacks captured at the start of the in-progress hand (for bust ordering). */
  private handStartStacks = new Map<number, number>();

  constructor(
    readonly tableId: string,
    initialConfig: TableConfig,
    private readonly deps: TournamentTableDeps,
  ) {
    this.engineConfig = initialConfig;
    this.pendingConfig = initialConfig;
    this.state = initGameState({ tableId, config: initialConfig, players: [] });
  }

  // --- read-only accessors ------------------------------------------------

  get gameState(): GameState {
    return this.state;
  }

  get handInProgress(): boolean {
    return this.state.street !== Street.Waiting && this.state.street !== Street.Complete;
  }

  get lastHandNumber(): number {
    return this.handNumber;
  }

  /** userId -> current stack, for every seat still holding chips. */
  stacks(): Map<string, number> {
    const out = new Map<string, number>();
    for (const e of this.roster.values()) out.set(e.userId, e.stack);
    return out;
  }

  seatOf(userId: string): number | null {
    for (const [seat, e] of this.roster) if (e.userId === userId) return seat;
    return null;
  }

  get seatedUserIds(): string[] {
    return [...this.roster.values()].map((e) => e.userId);
  }

  get chippedCount(): number {
    return [...this.roster.values()].filter((e) => e.stack > 0).length;
  }

  /** `userId | null` per seat, length `maxSeats` - the shape `planBalance` wants. */
  seatsArray(): (string | null)[] {
    const out: (string | null)[] = Array.from({ length: this.engineConfig.maxSeats }, () => null);
    for (const [seat, e] of this.roster) if (seat < out.length) out[seat] = e.userId;
    return out;
  }

  // --- coordinator commands ---------------------------------------------

  /** Place a player in a seat. Coordinator-driven: no buy-in, no validation
   * beyond the seat being free and in range. */
  seat(args: { userId: string; seat: number; stack: number; connected: boolean }): void {
    if (args.seat < 0 || args.seat >= this.engineConfig.maxSeats) {
      throw new Error(`seat ${args.seat} out of range for table ${this.tableId}`);
    }
    if (this.roster.has(args.seat)) throw new Error(`seat ${args.seat} already taken`);
    if (this.seatOf(args.userId) !== null) throw new Error(`${args.userId} already seated here`);
    this.roster.set(args.seat, {
      userId: args.userId,
      connected: args.connected,
      stack: args.stack,
    });
  }

  /** Remove a player from the table (a balance move, or a bust the coordinator
   * has finished recording). Returns their stack so the coordinator can seat it
   * elsewhere. Refused while that seat is contesting a live hand. */
  unseat(seat: number): number {
    const entry = this.roster.get(seat);
    if (!entry) return 0;
    if (this.handInProgress && this.contesting(seat)) {
      throw new Error(`cannot unseat ${seat} mid-hand at ${this.tableId}`);
    }
    this.roster.delete(seat);
    this.lastSeqByUser.delete(entry.userId);
    return entry.stack;
  }

  setConnected(userId: string, connected: boolean): void {
    const seat = this.seatOf(userId);
    if (seat === null) return;
    const entry = this.roster.get(seat);
    if (!entry || entry.connected === connected) return;
    entry.connected = connected;
    // Re-arm the acting player's clock in step with their connection.
    if (this.handInProgress && this.state.actingSeat === seat) this.armActionTimer();
  }

  /** New blinds/ante, applied at the next hand start. */
  setLevel(level: { smallBlind: number; bigBlind: number; ante: number }): void {
    this.pendingConfig = {
      ...this.engineConfig,
      smallBlind: level.smallBlind,
      bigBlind: level.bigBlind,
      ante: level.ante,
    };
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.maybeScheduleNextHand();
  }

  /** Freeze the table so the coordinator can move players on/off it. Cancels a
   * pending next-hand start; an in-progress hand is left to finish (the
   * coordinator only balances when nothing is in progress). */
  holdForBalance(): void {
    this.held = true;
    if (this.nextHandTimer !== null) {
      this.deps.timers.clear(this.nextHandTimer);
      this.nextHandTimer = null;
    }
  }

  releaseFromBalance(): void {
    if (!this.held) return;
    this.held = false;
    this.maybeScheduleNextHand();
  }

  /** Begin play (or resume it after a balance move). */
  start(): void {
    this.maybeScheduleNextHand();
  }

  submitAction(userId: string, handId: string, clientSeq: number, action: PlayerAction): void {
    this.enqueue({ type: 'ACTION', userId, handId, clientSeq, action });
  }

  /** Test hook / manual trigger. */
  requestStart(): void {
    this.enqueue({ type: 'START_HAND' });
  }

  dispose(): void {
    this.disposed = true;
    this.clearActionTimer();
    if (this.nextHandTimer !== null) {
      this.deps.timers.clear(this.nextHandTimer);
      this.nextHandTimer = null;
    }
  }

  // --- queue -----------------------------------------------------------

  private enqueue(cmd: Command): void {
    if (this.disposed) return;
    this.queue.push(cmd);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const cmd = this.queue.shift() as Command;
        try {
          this.handle(cmd);
        } catch (err) {
          this.deps.notify({
            kind: 'rejected',
            userId: 'userId' in cmd ? cmd.userId : 'system',
            code: 'RUNNER_ERROR',
            reason: (err as Error).message,
          });
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private handle(cmd: Command): void {
    switch (cmd.type) {
      case 'START_HAND':
        return this.onStartHand();
      case 'ACTION':
        return this.onAction(cmd);
      case 'TIMEOUT':
        return this.onTimeout(cmd.seat, cmd.handId);
    }
  }

  // --- hand lifecycle -------------------------------------------------

  private onStartHand(): void {
    this.nextHandTimer = null;
    if (this.handInProgress || this.paused || this.held || this.disposed) return;

    const eligible = [...this.roster.entries()]
      .filter(([, e]) => e.stack > 0)
      .sort(([a], [b]) => a - b);
    if (eligible.length < 2) {
      this.deps.notify({ kind: 'idle' });
      return;
    }

    this.engineConfig = this.pendingConfig;
    this.handNumber += 1;
    this.lastSeqByUser.clear();
    this.handStartStacks = new Map(eligible.map(([seat, e]) => [seat, e.stack]));

    this.state = initGameState({
      tableId: this.tableId,
      config: this.engineConfig,
      players: eligible.map(([seat, e]) => ({
        userId: e.userId,
        seatNumber: seat,
        stack: e.stack,
      })),
    });

    this.applyEngine({
      type: 'START_HAND',
      handId: randomUUID(),
      handNumber: this.handNumber,
      previousPositions: this.previousPositions,
    });
  }

  private onAction(cmd: Extract<Command, { type: 'ACTION' }>): void {
    const seat = this.seatOf(cmd.userId);
    if (seat === null) {
      this.reject(cmd.userId, 'NOT_SEATED', 'you are not seated at this table');
      return;
    }
    if (this.state.handId !== cmd.handId) {
      this.reject(cmd.userId, 'STALE_HAND', 'that hand is no longer in progress');
      return;
    }
    const lastSeq = this.lastSeqByUser.get(cmd.userId) ?? -1;
    if (cmd.clientSeq <= lastSeq) return; // duplicate / out-of-order resend
    this.lastSeqByUser.set(cmd.userId, cmd.clientSeq);
    this.applyEngine({ type: 'PLAYER_ACTION', seat, action: cmd.action }, cmd.userId);
  }

  private onTimeout(seat: number, handId: string): void {
    if (this.state.handId !== handId || this.state.actingSeat !== seat) return;
    this.applyEngine({ type: 'TIMEOUT', seat });
  }

  private applyEngine(action: EngineAction, actorUserId?: string): void {
    const { state, events } = reduce(this.state, action, this.deps.rng);

    const rejection = events.find((e) => e.type === 'ACTION_REJECTED');
    if (rejection && rejection.type === 'ACTION_REJECTED') {
      this.reject(actorUserId ?? 'system', rejection.code, rejection.reason);
      return;
    }

    this.clearActionTimer();
    this.state = state;

    const completed = events.some((e) => e.type === 'HAND_COMPLETED');
    if (events.length > 0) this.deps.notify({ kind: 'events', events });

    if (completed) {
      this.onHandComplete();
    } else {
      this.armActionTimer();
      this.deps.notify({ kind: 'state' });
    }
  }

  private onHandComplete(): void {
    this.previousPositions = previousPositionsOf(this.state);

    const results: TournamentHandResult[] = [];
    const busted: { seat: number; userId: string; stackAtHandStart: number }[] = [];
    for (const player of this.state.players) {
      const entry = this.roster.get(player.seatNumber);
      if (!entry) continue;
      const started = this.handStartStacks.get(player.seatNumber) ?? player.stack;
      entry.stack = player.stack;
      results.push({
        seat: player.seatNumber,
        userId: player.userId,
        stackAtHandStart: started,
        endStack: player.stack,
        net: player.stack - started,
      });
      if (player.stack === 0) {
        busted.push({ seat: player.seatNumber, userId: player.userId, stackAtHandStart: started });
      }
    }
    // Smallest starting stack busts first = worst finishing position.
    busted.sort((a, b) => a.stackAtHandStart - b.stackAtHandStart);

    this.deps.notify({ kind: 'handComplete', handNumber: this.handNumber, results, busted });
    this.deps.notify({ kind: 'state' });
    this.maybeScheduleNextHand();
  }

  // --- timers --------------------------------------------------------

  private armActionTimer(): void {
    this.clearActionTimer();
    if (this.state.actingSeat === null) {
      this.state = { ...this.state, actionDeadline: null };
      return;
    }
    const seat = this.state.actingSeat;
    const handId = this.state.handId;
    const entry = this.roster.get(seat);
    const away = entry !== undefined && !entry.connected;
    const timeoutMs = away
      ? Math.min(this.deps.disconnectGraceMs, this.deps.actionTimeoutMs)
      : this.deps.actionTimeoutMs;
    this.state = { ...this.state, actionDeadline: this.deps.now() + timeoutMs };
    this.actionTimer = this.deps.timers.set(() => {
      this.enqueue({ type: 'TIMEOUT', seat, handId });
    }, timeoutMs);
  }

  private clearActionTimer(): void {
    if (this.actionTimer !== null) {
      this.deps.timers.clear(this.actionTimer);
      this.actionTimer = null;
    }
  }

  private maybeScheduleNextHand(): void {
    if (this.disposed || this.paused || this.held) return;
    if (this.nextHandTimer !== null || this.handInProgress) return;
    if (this.chippedCount < 2) {
      this.deps.notify({ kind: 'idle' });
      return;
    }
    this.nextHandTimer = this.deps.timers.set(() => {
      this.nextHandTimer = null;
      this.enqueue({ type: 'START_HAND' });
    }, this.deps.nextHandDelayMs);
  }

  private contesting(seat: number): boolean {
    return this.state.players.some(
      (p) =>
        p.seatNumber === seat &&
        (p.status === PlayerStatus.Active || p.status === PlayerStatus.AllIn),
    );
  }

  private reject(userId: string, code: string, reason: string): void {
    this.deps.notify({ kind: 'rejected', userId, code, reason });
  }
}
