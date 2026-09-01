import { randomUUID } from 'node:crypto';
import {
  type EngineAction,
  type GameEvent,
  type GameState,
  type PlayerAction,
  PlayerStatus,
  type RandomProvider,
  Street,
  type TableConfig,
  initGameState,
  reduce,
} from '@river/poker-engine';
import type { TableChatMessage } from '@river/shared-types';
import { revealedByEvents } from './event-projection';
import type { RosterEntry, TableMeta } from './table-projection';

export type RunnerNotification =
  | { kind: 'state' }
  | { kind: 'events'; events: GameEvent[] }
  | { kind: 'rejected'; userId: string; code: string; reason: string }
  | { kind: 'chat'; message: TableChatMessage }
  | { kind: 'handComplete' }
  | { kind: 'seatVacated' };

export interface TimerScheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: TimerScheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface RunnerConfig {
  actionTimeoutMs: number;
  nextHandDelayMs: number;
  startDelayMs: number;
}

export interface RunnerDeps {
  rng: RandomProvider;
  timers: TimerScheduler;
  now: () => number;
  config: RunnerConfig;
  notify: (n: RunnerNotification) => void;
  /** Called after every hand and on seat changes so the DB roster stays current. */
  persistRoster: (runner: TableRunner) => void;
  /** Called when a seat is freed - the caller credits the stack back to chips
   * and may promote the head of the waitlist. */
  onSeatVacated: (userId: string, stack: number) => void;
  /** Completed-hand pot total, for the lobby's rolling average. */
  recordHandStats: (potTotal: number) => void;
}

interface JoinArgs {
  userId: string;
  username: string;
  avatarUrl: string | null;
  seatNumber: number;
  stack: number;
  connected: boolean;
}

type Command =
  | { type: 'JOIN'; args: JoinArgs }
  | { type: 'LEAVE'; userId: string }
  | { type: 'CONNECTED'; userId: string; connected: boolean }
  | { type: 'SIT'; userId: string; sittingOut: boolean }
  | {
      type: 'ACTION';
      userId: string;
      handId: string;
      clientSeq: number;
      action: PlayerAction;
    }
  | { type: 'TIMEOUT'; seat: number; handId: string }
  | { type: 'START_HAND' }
  | { type: 'CHAT'; userId: string; username: string; text: string };

/**
 * One table = one single-writer actor. Every command runs to completion on a
 * serial queue, so no two actions for the same table are ever interleaved. The
 * authoritative GameState lives here; the gateway only ever reads projections.
 */
export class TableRunner {
  private state: GameState;
  private readonly roster = new Map<number, RosterEntry & { pendingLeave: boolean }>();
  private readonly queue: Command[] = [];
  private draining = false;

  private handNumber = 0;
  private previousButtonSeat: number | null = null;
  private readonly revealedSeats = new Set<number>();
  private readonly lastSeqByUser = new Map<string, number>();

  private actionTimer: unknown = null;
  private nextHandTimer: unknown = null;

  constructor(
    readonly meta: TableMeta,
    private readonly engineConfig: TableConfig,
    private readonly deps: RunnerDeps,
  ) {
    this.state = initGameState({ tableId: meta.id, config: engineConfig, players: [] });
  }

  // --- read-only accessors used by the projection layer ---------------------

  get gameState(): GameState {
    return this.state;
  }

  get rosterEntries(): ReadonlyMap<number, RosterEntry> {
    return this.roster;
  }

  get revealed(): ReadonlySet<number> {
    return this.revealedSeats;
  }

  seatOf(userId: string): number | null {
    for (const [seat, entry] of this.roster) if (entry.userId === userId) return seat;
    return null;
  }

  isEmpty(): boolean {
    return this.roster.size === 0;
  }

  get seatedCount(): number {
    return this.roster.size;
  }

  get handInProgress(): boolean {
    return this.state.street !== Street.Waiting && this.state.street !== Street.Complete;
  }

  rosterSnapshot(): {
    seatNumber: number;
    userId: string | null;
    stack: number;
    sittingOut: boolean;
  }[] {
    const rows: {
      seatNumber: number;
      userId: string | null;
      stack: number;
      sittingOut: boolean;
    }[] = [];
    for (let seat = 0; seat < this.meta.maxSeats; seat += 1) {
      const entry = this.roster.get(seat);
      rows.push(
        entry
          ? {
              seatNumber: seat,
              userId: entry.userId,
              stack: entry.stack,
              sittingOut: entry.sittingOut,
            }
          : { seatNumber: seat, userId: null, stack: 0, sittingOut: false },
      );
    }
    return rows;
  }

  get lastHandNumber(): number {
    return this.handNumber;
  }

  get lastButtonSeat(): number | null {
    return this.previousButtonSeat;
  }

  /** Restore full live state (incl. an in-progress hand) from a Redis snapshot. */
  hydrateFromSnapshot(
    snapshot: {
      state: GameState;
      handNumber: number;
      buttonSeat: number | null;
      roster: {
        seatNumber: number;
        userId: string;
        username: string;
        avatarUrl: string | null;
        stack: number;
        sittingOut: boolean;
      }[];
    },
    usernames: ReadonlyMap<string, { username: string; avatarUrl: string | null }>,
  ): void {
    this.state = { ...snapshot.state, actionDeadline: null };
    this.handNumber = snapshot.handNumber;
    this.previousButtonSeat = snapshot.buttonSeat;
    for (const r of snapshot.roster) {
      const meta = usernames.get(r.userId);
      this.roster.set(r.seatNumber, {
        userId: r.userId,
        username: meta?.username ?? r.username,
        avatarUrl: meta?.avatarUrl ?? r.avatarUrl,
        connected: false,
        stack: r.stack,
        sittingOut: r.sittingOut,
        pendingLeave: false,
      });
    }
    // An in-progress hand cannot fairly resume with everyone disconnected;
    // re-arm the action timer only once someone reconnects (handled on CONNECTED).
    if (
      this.state.street !== Street.Waiting &&
      this.state.street !== Street.Complete &&
      this.state.actingSeat !== null
    ) {
      this.armActionTimer();
    }
  }

  /** Restore the roster from a persisted table (after an API restart). */
  hydrate(
    seats: readonly {
      seatNumber: number;
      userId: string | null;
      stack: number;
      sittingOut: boolean;
    }[],
    usernames: ReadonlyMap<string, { username: string; avatarUrl: string | null }>,
    handNumber: number,
    buttonSeat: number | null,
  ): void {
    for (const seat of seats) {
      if (!seat.userId) continue;
      const meta = usernames.get(seat.userId);
      this.roster.set(seat.seatNumber, {
        userId: seat.userId,
        username: meta?.username ?? 'player',
        avatarUrl: meta?.avatarUrl ?? null,
        connected: false,
        stack: seat.stack,
        sittingOut: seat.sittingOut,
        pendingLeave: false,
      });
    }
    this.handNumber = handNumber;
    this.previousButtonSeat = buttonSeat;
  }

  // --- commands ------------------------------------------------------------

  join(args: JoinArgs): void {
    this.enqueue({ type: 'JOIN', args });
  }
  leave(userId: string): void {
    this.enqueue({ type: 'LEAVE', userId });
  }
  setConnected(userId: string, connected: boolean): void {
    this.enqueue({ type: 'CONNECTED', userId, connected });
  }
  setSittingOut(userId: string, sittingOut: boolean): void {
    this.enqueue({ type: 'SIT', userId, sittingOut });
  }
  submitAction(userId: string, handId: string, clientSeq: number, action: PlayerAction): void {
    this.enqueue({ type: 'ACTION', userId, handId, clientSeq, action });
  }
  chat(userId: string, username: string, text: string): void {
    this.enqueue({ type: 'CHAT', userId, username, text });
  }
  /** Test hook / manual trigger. */
  requestStart(): void {
    this.enqueue({ type: 'START_HAND' });
  }

  // --- queue --------------------------------------------------------------

  private enqueue(cmd: Command): void {
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
            userId: 'userId' in cmd ? (cmd.userId as string) : 'system',
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
      case 'JOIN':
        return this.onJoin(cmd.args);
      case 'LEAVE':
        return this.onLeave(cmd.userId);
      case 'CONNECTED':
        return this.onConnected(cmd.userId, cmd.connected);
      case 'SIT':
        return this.onSit(cmd.userId, cmd.sittingOut);
      case 'ACTION':
        return this.onAction(cmd);
      case 'TIMEOUT':
        return this.onTimeout(cmd.seat, cmd.handId);
      case 'START_HAND':
        return this.onStartHand();
      case 'CHAT':
        return this.onChat(cmd.userId, cmd.username, cmd.text);
    }
  }

  private onJoin(args: JoinArgs): void {
    if (this.seatOf(args.userId) !== null) {
      this.reject(args.userId, 'ALREADY_SEATED', 'you are already at this table');
      return;
    }
    if (this.roster.has(args.seatNumber)) {
      this.reject(args.userId, 'SEAT_TAKEN', 'that seat is taken');
      return;
    }
    if (args.stack < this.meta.minBuyIn || args.stack > this.meta.maxBuyIn) {
      this.reject(
        args.userId,
        'BAD_BUY_IN',
        `buy-in must be ${this.meta.minBuyIn}-${this.meta.maxBuyIn}`,
      );
      return;
    }
    this.roster.set(args.seatNumber, {
      userId: args.userId,
      username: args.username,
      avatarUrl: args.avatarUrl,
      connected: args.connected,
      stack: args.stack,
      sittingOut: false,
      pendingLeave: false,
    });
    this.deps.persistRoster(this);
    this.deps.notify({ kind: 'state' });
    this.maybeScheduleStart();
  }

  private onLeave(userId: string): void {
    const seat = this.seatOf(userId);
    if (seat === null) return;
    const entry = this.roster.get(seat);
    if (!entry) return;

    const inLiveHand =
      this.state.street !== Street.Waiting &&
      this.state.street !== Street.Complete &&
      this.state.players.some(
        (p) =>
          p.seatNumber === seat &&
          (p.status === PlayerStatus.Active || p.status === PlayerStatus.AllIn),
      );

    if (inLiveHand) {
      entry.pendingLeave = true;
      // if it is their turn, fold them out now
      if (this.state.actingSeat === seat && this.state.handId) {
        this.applyEngine({ type: 'PLAYER_ACTION', seat, action: { type: 'FOLD' } });
      }
      return;
    }

    this.roster.delete(seat);
    this.deps.onSeatVacated(userId, entry.stack);
    this.deps.persistRoster(this);
    this.deps.notify({ kind: 'state' });
  }

  private onConnected(userId: string, connected: boolean): void {
    const seat = this.seatOf(userId);
    if (seat === null) return;
    const entry = this.roster.get(seat);
    if (!entry || entry.connected === connected) return;
    entry.connected = connected;
    this.deps.notify({ kind: 'state' });
  }

  private onSit(userId: string, sittingOut: boolean): void {
    const seat = this.seatOf(userId);
    if (seat === null) return;
    const entry = this.roster.get(seat);
    if (!entry) return;
    entry.sittingOut = sittingOut;
    this.deps.notify({ kind: 'state' });
    if (!sittingOut) this.maybeScheduleStart();
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

  private onChat(userId: string, username: string, text: string): void {
    const message: TableChatMessage = {
      tableId: this.meta.id,
      seatNumber: this.seatOf(userId),
      userId,
      username,
      text,
      at: new Date(this.deps.now()).toISOString(),
    };
    this.deps.notify({ kind: 'chat', message });
  }

  private onStartHand(): void {
    this.nextHandTimer = null;
    if (this.state.street !== Street.Waiting && this.state.street !== Street.Complete) return;

    const eligible = [...this.roster.entries()]
      .filter(([, e]) => !e.sittingOut && !e.pendingLeave && e.stack > 0)
      .sort(([a], [b]) => a - b);
    if (eligible.length < 2) return;

    this.handNumber += 1;
    this.revealedSeats.clear();
    const fresh = initGameState({
      tableId: this.meta.id,
      config: this.engineConfig,
      players: eligible.map(([seat, e]) => ({
        userId: e.userId,
        seatNumber: seat,
        stack: e.stack,
      })),
    });
    this.state = fresh;
    this.applyEngine({
      type: 'START_HAND',
      handId: randomUUID(),
      handNumber: this.handNumber,
      previousButtonSeat: this.previousButtonSeat,
    });
  }

  // --- engine bridge -----------------------------------------------------

  private applyEngine(action: EngineAction, actorUserId?: string): void {
    const { state, events } = reduce(this.state, action, this.deps.rng);

    const rejection = events.find((e) => e.type === 'ACTION_REJECTED');
    if (rejection && rejection.type === 'ACTION_REJECTED') {
      // Nothing changed - just tell the actor why.
      this.reject(actorUserId ?? 'system', rejection.code, rejection.reason);
      return;
    }

    this.clearActionTimer();
    this.state = state;
    for (const seat of revealedByEvents(events)) this.revealedSeats.add(seat);

    const completed = events.some((e) => e.type === 'HAND_COMPLETED');
    if (events.length > 0) this.deps.notify({ kind: 'events', events });

    if (completed) {
      this.onHandComplete();
    } else {
      this.armActionTimer();
    }
    this.deps.notify({ kind: 'state' });
  }

  private onHandComplete(): void {
    this.previousButtonSeat = this.state.buttonSeat;
    this.deps.recordHandStats(this.state.pots.reduce((sum, pot) => sum + pot.amount, 0));
    for (const player of this.state.players) {
      const entry = this.roster.get(player.seatNumber);
      if (!entry) continue;
      entry.stack = player.stack;
      if (player.stack === 0) entry.sittingOut = true;
    }
    // remove players who asked to leave during the hand
    for (const [seat, entry] of [...this.roster.entries()]) {
      if (entry.pendingLeave) {
        this.roster.delete(seat);
        this.deps.onSeatVacated(entry.userId, entry.stack);
      }
    }
    this.deps.persistRoster(this);
    this.deps.notify({ kind: 'handComplete' });
    this.scheduleNextHand();
  }

  // --- timers ----------------------------------------------------------

  private armActionTimer(): void {
    this.clearActionTimer();
    if (this.state.actingSeat === null) {
      this.state = { ...this.state, actionDeadline: null };
      return;
    }
    const seat = this.state.actingSeat;
    const handId = this.state.handId;
    const deadline = this.deps.now() + this.deps.config.actionTimeoutMs;
    this.state = { ...this.state, actionDeadline: deadline };
    this.actionTimer = this.deps.timers.set(() => {
      this.enqueue({ type: 'TIMEOUT', seat, handId });
    }, this.deps.config.actionTimeoutMs);
  }

  private clearActionTimer(): void {
    if (this.actionTimer !== null) {
      this.deps.timers.clear(this.actionTimer);
      this.actionTimer = null;
    }
  }

  private scheduleNextHand(): void {
    if (this.nextHandTimer !== null) return;
    this.nextHandTimer = this.deps.timers.set(() => {
      this.nextHandTimer = null;
      this.enqueue({ type: 'START_HAND' });
    }, this.deps.config.nextHandDelayMs);
  }

  private maybeScheduleStart(): void {
    if (this.state.street !== Street.Waiting && this.state.street !== Street.Complete) return;
    if (this.nextHandTimer !== null) return;
    const eligible = [...this.roster.values()].filter((e) => !e.sittingOut && e.stack > 0);
    if (eligible.length < 2) return;
    this.nextHandTimer = this.deps.timers.set(() => {
      this.nextHandTimer = null;
      this.enqueue({ type: 'START_HAND' });
    }, this.deps.config.startDelayMs);
  }

  private reject(userId: string, code: string, reason: string): void {
    this.deps.notify({ kind: 'rejected', userId, code, reason });
  }

  /** Test/shutdown helper. */
  dispose(): void {
    this.clearActionTimer();
    if (this.nextHandTimer !== null) {
      this.deps.timers.clear(this.nextHandTimer);
      this.nextHandTimer = null;
    }
  }
}
