import { randomUUID } from 'node:crypto';
import {
  cardToString,
  type EngineAction,
  type GameEvent,
  type GameState,
  GameVariant,
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
import type { TableChatMessage } from '@river/shared-types';
import { revealedByEvents } from './event-projection';
import type { RosterEntry, TableMeta } from './table-projection';

export type RunnerNotification =
  | { kind: 'state' }
  | { kind: 'events'; events: GameEvent[] }
  | { kind: 'rejected'; userId: string; code: string; reason: string }
  | { kind: 'chat'; message: TableChatMessage }
  | { kind: 'handComplete' }
  | { kind: 'seatVacated' }
  | { kind: 'timeCharge'; userId: string; seatNumber: number; amount: number };

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
  /** Shorter action clock used while the acting player's socket is gone. */
  disconnectGraceMs: number;
  /** A seated player disconnected this long is stood up (seat + stack freed). */
  awayMaxMs: number;
  /** ...or once they've missed this many hands while away, whichever is first. */
  awayMaxMissedHands: number;
}

export interface RunnerDeps {
  rng: RandomProvider;
  timers: TimerScheduler;
  now: () => number;
  config: RunnerConfig;
  notify: (n: RunnerNotification) => void;
  /** Called after every hand and on seat changes so the DB roster stays current. */
  persistRoster: (runner: TableRunner) => void;
  /** Called when a seat is freed - the caller cashes the stack back out (via a
   * transactional, idempotent `standUp` keyed by `idemKey`) and may promote the
   * head of the waitlist. */
  onSeatVacated: (args: {
    userId: string;
    seatNumber: number;
    stack: number;
    idemKey: string;
  }) => void;
  /** Completed-hand pot total, for the lobby's rolling average. */
  recordHandStats: (potTotal: number) => void;
  /** A finished hand, for persistence (hand history + replay). */
  recordHand: (hand: CompletedHand) => void;
  /** Fire-and-forget: debit the table's flat time charge from a player's chip
   * wallet (never their on-table stack). No feedback path - an insufficient
   * wallet just fails to charge; see applyTimeCharges' doc comment. */
  chargeAccount: (args: {
    userId: string;
    seatNumber: number;
    amount: number;
    idemKey: string;
  }) => void;
}

/** Roster entry plus the bookkeeping the runner keeps but never projects. */
type RosterEntryInternal = RosterEntry & {
  pendingLeave: boolean;
  /** When their socket dropped (ms), or null while connected. */
  awaySince: number | null;
  /** Hands they've missed since going away. */
  missedHands: number;
};

interface JoinArgs {
  userId: string;
  username: string;
  avatarUrl: string | null;
  seatNumber: number;
  stack: number;
  connected: boolean;
}

export type JoinOutcome = { ok: true } | { ok: false; code: string; reason: string };

/** A finished hand, ready to persist for dispute resolution + replay. */
export interface CompletedHand {
  engineHandId: string;
  handNumber: number;
  startedAt: number;
  endedAt: number;
  /** 52-card deal order, compact strings - the replay input. */
  deck: string[];
  buttonSeat: number;
  smallBlindSeat: number | null;
  bigBlindSeat: number;
  /** The prior hand's positions - the other `replayHand` input. null for hand 1. */
  prevPositions: PreviousPositions | null;
  seats: { seat: number; userId: string; username: string; startStack: number }[];
  /** The PLAYER_ACTION / TIMEOUT sequence after START_HAND - the replay input. */
  actions: EngineAction[];
  board: string[];
  results: { seat: number; userId: string; net: number; endStack: number }[];
  potTotal: number;
  /** Per-player bomb-pot contribution if this hand was a bomb pot; 0 otherwise. */
  bombPotAmount: number;
}

/** Bomb-pot runtime state - the per-table completed-hand counter and whether
 * the current hand is a bomb pot. Persisted in the Redis snapshot (warm
 * restart) and, less finely, on `PokerTable` (cold restart). */
export interface BombPotState {
  handsSinceLastBomb: number;
  currentHandIsBomb: boolean;
  currentBombAmount: number;
}

type Command =
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
  private readonly roster = new Map<number, RosterEntryInternal>();
  private readonly queue: Command[] = [];
  private draining = false;

  private handNumber = 0;
  /** Positions of the last completed hand - drives the forward-moving big
   * blind. null until the first hand finishes. */
  private previousPositions: PreviousPositions | null = null;
  private readonly revealedSeats = new Set<number>();
  private readonly lastSeqByUser = new Map<string, number>();

  /** Bomb-pot completed-hand counter and current-hand flag (ADR-0026).
   * `handsSinceLastBomb` only ever advances in `onHandComplete` - exactly one
   * authoritative site. Both survive restart (Redis snapshot + PokerTable). */
  private handsSinceLastBomb = 0;
  private currentHandIsBomb = false;
  private currentBombAmount = 0;

  private actionTimer: unknown = null;
  private nextHandTimer: unknown = null;
  /** Periodic check that stands up players who've been away too long. Runs only
   * while at least one seated player is disconnected. */
  private awayTimer: unknown = null;

  /** Accumulates what's needed to persist the in-progress hand. */
  private handLog: {
    startedAt: number;
    deck: string[];
    prevPositions: PreviousPositions | null;
    seats: CompletedHand['seats'];
    actions: EngineAction[];
    bombPotAmount: number;
  } | null = null;

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

  /** Full last-hand positions, for persistence / cold-restart recovery. */
  get lastPositions(): PreviousPositions | null {
    return this.previousPositions;
  }

  /** The bomb-pot completed-hand counter, for `PokerTable` persistence. */
  get bombHandCounter(): number {
    return this.handsSinceLastBomb;
  }

  /** Raw bomb-pot runtime state, for the Redis snapshot. */
  bombPotSnapshot(): BombPotState {
    return {
      handsSinceLastBomb: this.handsSinceLastBomb,
      currentHandIsBomb: this.currentHandIsBomb,
      currentBombAmount: this.currentBombAmount,
    };
  }

  /** The per-player bomb-pot amount this table uses (0 config means "big blind"). */
  private bombAmount(): number {
    return this.meta.bombPotAmount > 0 ? this.meta.bombPotAmount : this.engineConfig.bigBlind;
  }

  /** Hands between bomb pots. Floored at 1 so a bad `0` row can't turn every
   * hand into a bomb pot (the admin path validates this too). */
  private bombInterval(): number {
    return Math.max(1, this.meta.bombPotIntervalHands);
  }

  /** Public bomb-pot state for the projection; `null` when the table doesn't run
   * bomb pots. `nextInHands` is the countdown to the next bomb (0 = this hand). */
  bombPotView(): { active: boolean; amount: number; nextInHands: number } | null {
    if (!this.meta.bombPotEnabled) return null;
    return {
      active: this.currentHandIsBomb,
      amount: this.currentHandIsBomb ? this.currentBombAmount : this.bombAmount(),
      nextInHands: this.currentHandIsBomb
        ? 0
        : Math.max(0, this.bombInterval() - this.handsSinceLastBomb),
    };
  }

  /** Apply an admin config change to this running table. Only the fields that
   * are safe to swap mid-session (bomb-pot cadence) live on `meta`; `isPrivate`
   * is lobby-only and needs nothing here. The completed-hand counter is left
   * exactly where it is - toggling `bombPotEnabled` freezes/resumes it, never
   * resets it. Takes effect on the next hand (the current hand, bomb or not,
   * runs to completion under the terms it started with). */
  applyConfigPatch(patch: {
    bombPotEnabled?: boolean;
    bombPotIntervalHands?: number;
    bombPotAmount?: number;
  }): void {
    if (patch.bombPotEnabled !== undefined) this.meta.bombPotEnabled = patch.bombPotEnabled;
    if (patch.bombPotIntervalHands !== undefined) {
      this.meta.bombPotIntervalHands = patch.bombPotIntervalHands;
    }
    if (patch.bombPotAmount !== undefined) this.meta.bombPotAmount = patch.bombPotAmount;
    this.deps.notify({ kind: 'state' });
  }

  /** Restore full live state (incl. an in-progress hand) from a Redis snapshot. */
  hydrateFromSnapshot(
    snapshot: {
      state: GameState;
      handNumber: number;
      previousPositions?: PreviousPositions | null;
      bombPot?: BombPotState;
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
    // Backfill any config field absent from an older snapshot (e.g. `variant`,
    // added in ADR-0013) from the freshly-built engine config; a present field
    // in the snapshot still wins so an in-flight hand keeps its own terms.
    this.state = {
      ...snapshot.state,
      config: { ...this.engineConfig, ...snapshot.state.config },
      actionDeadline: null,
    };
    this.handNumber = snapshot.handNumber;
    // Prefer an explicit record; otherwise recover it from the persisted state
    // (its button/blind seats still hold the last hand's until the next deal).
    this.previousPositions =
      snapshot.previousPositions ??
      (snapshot.state.buttonSeat >= 0 ? previousPositionsOf(snapshot.state) : null);
    if (snapshot.bombPot) {
      this.handsSinceLastBomb = snapshot.bombPot.handsSinceLastBomb;
      this.currentHandIsBomb = snapshot.bombPot.currentHandIsBomb;
      this.currentBombAmount = snapshot.bombPot.currentBombAmount;
    }
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
        awaySince: this.deps.now(),
        missedHands: 0,
        lastTimeChargeAt: this.deps.now(),
      });
    }
    // Every restored seat starts disconnected. An in-progress hand cannot
    // fairly resume with nobody watching, so the action timer stays unarmed
    // until the first client reconnects (see onConnected). If the whole table
    // is gone for good, TableManager tears the runner down.
    this.maybeArmAwaySweep();
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
    previous: PreviousPositions | null,
    handsSinceLastBomb = 0,
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
        awaySince: this.deps.now(),
        missedHands: 0,
        lastTimeChargeAt: this.deps.now(),
      });
    }
    this.handNumber = handNumber;
    this.previousPositions = previous;
    // Cold restart (no Redis snapshot): the persisted counter is enough to keep
    // the bomb-pot cadence correct; there is no in-progress hand to resume, so
    // the current-hand flag stays false.
    this.handsSinceLastBomb = handsSinceLastBomb;
    this.maybeArmAwaySweep();
  }

  // --- commands ------------------------------------------------------------

  /**
   * Seats a player and returns the outcome synchronously. The command queue
   * never yields (no handler awaits), and `join` is only ever called from the
   * single-threaded gateway, so `this.draining` is always false here - the
   * caller can immediately refund a debited buy-in if the seat was lost.
   */
  join(args: JoinArgs): JoinOutcome {
    return this.onJoin(args);
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

  private onJoin(args: JoinArgs): JoinOutcome {
    if (this.seatOf(args.userId) !== null) {
      return { ok: false, code: 'ALREADY_SEATED', reason: 'you are already at this table' };
    }
    if (args.seatNumber < 0 || args.seatNumber >= this.meta.maxSeats) {
      return { ok: false, code: 'BAD_SEAT', reason: 'no such seat' };
    }
    if (this.roster.has(args.seatNumber)) {
      return { ok: false, code: 'SEAT_TAKEN', reason: 'that seat is taken' };
    }
    if (args.stack < this.meta.minBuyIn || args.stack > this.meta.maxBuyIn) {
      return {
        ok: false,
        code: 'BAD_BUY_IN',
        reason: `buy-in must be ${this.meta.minBuyIn}-${this.meta.maxBuyIn}`,
      };
    }
    this.roster.set(args.seatNumber, {
      userId: args.userId,
      username: args.username,
      avatarUrl: args.avatarUrl,
      connected: args.connected,
      stack: args.stack,
      sittingOut: false,
      pendingLeave: false,
      awaySince: args.connected ? null : this.deps.now(),
      missedHands: 0,
      lastTimeChargeAt: this.deps.now(),
    });
    this.deps.persistRoster(this);
    this.deps.notify({ kind: 'state' });
    this.maybeScheduleStart();
    return { ok: true };
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
    this.lastSeqByUser.delete(userId);
    this.deps.onSeatVacated({
      userId,
      seatNumber: seat,
      stack: entry.stack,
      idemKey: `cashout:${randomUUID()}`,
    });
    this.deps.persistRoster(this);
    this.deps.notify({ kind: 'state' });
  }

  /** Remove seats whose player asked to leave, crediting their stack. Called
   * from `onHandComplete` and when the table can't start a hand. */
  private releasePendingLeavers(): void {
    let changed = false;
    for (const [seat, entry] of [...this.roster.entries()]) {
      if (!entry.pendingLeave) continue;
      this.roster.delete(seat);
      this.lastSeqByUser.delete(entry.userId);
      this.deps.onSeatVacated({
        userId: entry.userId,
        seatNumber: seat,
        stack: entry.stack,
        idemKey: `cashout:${randomUUID()}`,
      });
      changed = true;
    }
    if (changed) {
      this.deps.persistRoster(this);
      this.deps.notify({ kind: 'state' });
    }
  }

  /** Stand up any player who has been disconnected past the away limit (time or
   * missed hands): free the seat, return the stack, and tell them why.
   *
   * Only safe to call between hands - `entry.stack` is the roster cache, which
   * is only true to the engine at hand start / completion. Cashing a player out
   * mid-hand would return a stale stack while their committed chips are still
   * live in the pot, minting chips. Callers must guard on `!handInProgress`. */
  private sweepAwayPlayers(now: number): void {
    if (this.handInProgress) return;
    let changed = false;
    for (const [seat, entry] of [...this.roster.entries()]) {
      if (entry.connected || entry.awaySince === null) continue;
      const tooLong = now - entry.awaySince >= this.deps.config.awayMaxMs;
      const tooMany = entry.missedHands >= this.deps.config.awayMaxMissedHands;
      if (!tooLong && !tooMany) continue;

      this.roster.delete(seat);
      this.lastSeqByUser.delete(entry.userId);
      this.deps.onSeatVacated({
        userId: entry.userId,
        seatNumber: seat,
        stack: entry.stack,
        idemKey: `away:${randomUUID()}`,
      });
      this.deps.notify({
        kind: 'rejected',
        userId: entry.userId,
        code: 'REMOVED_INACTIVE',
        reason: 'You were removed from the table for inactivity; your chips were returned.',
      });
      changed = true;
    }
    if (changed) {
      this.deps.persistRoster(this);
      this.deps.notify({ kind: 'state' });
    }
  }

  /**
   * Flat per-seat time charge (a Texas-card-room-style membership fee, not a
   * pot rake) - every seated, not-sitting-out player pays `timeChargeAmount`
   * per `timeChargeIntervalMs` they occupy a seat, win or lose. Disabled
   * table-wide when either is 0. Only safe to call between hands - same
   * constraint as sweepAwayPlayers above (lastTimeChargeAt bookkeeping is
   * roster state, and the roster is only trustworthy between hands).
   *
   * Billed against the player's chip *wallet*, never their on-table stack -
   * `deps.chargeAccount` is fire-and-forget (like persistRoster/onSeatVacated,
   * it settles asynchronously against the DB) and simply no-ops if their
   * wallet can't cover it; the runner never learns whether it succeeded, so a
   * seat is never touched here. That's a deliberate limitation: an empty
   * wallet doesn't stop someone from playing yet. Revisit before real money.
   */
  private applyTimeCharges(now: number): void {
    if (this.handInProgress) return;
    const { timeChargeAmount, timeChargeIntervalMs } = this.meta;
    if (timeChargeAmount <= 0 || timeChargeIntervalMs <= 0) return;

    for (const [seat, entry] of this.roster.entries()) {
      if (entry.sittingOut || entry.pendingLeave) continue;

      // A table idle for a long stretch (or a slow cold-start recovery) could
      // owe several intervals at once - settle all of them, capped so a
      // clock stuck far in the past can't loop indefinitely.
      let guard = 0;
      while (now - entry.lastTimeChargeAt >= timeChargeIntervalMs && guard < 100) {
        guard += 1;
        entry.lastTimeChargeAt += timeChargeIntervalMs;
        this.deps.chargeAccount({
          userId: entry.userId,
          seatNumber: seat,
          amount: timeChargeAmount,
          idemKey: `timecharge:${randomUUID()}`,
        });
        this.deps.notify({
          kind: 'timeCharge',
          userId: entry.userId,
          seatNumber: seat,
          amount: timeChargeAmount,
        });
      }
    }
  }

  /** (Re)arm the periodic away sweep if anyone is disconnected and it isn't
   * already running. Self-cancels once everyone is back. */
  private maybeArmAwaySweep(): void {
    if (this.awayTimer !== null) return;
    if (![...this.roster.values()].some((e) => !e.connected)) return;
    const period = Math.min(this.deps.config.awayMaxMs, 30_000);
    this.awayTimer = this.deps.timers.set(() => {
      this.awayTimer = null;
      // No-op while a hand is live (sweepAwayPlayers guards this too); the sweep
      // that matters between hands runs from onStartHand / onHandComplete.
      this.sweepAwayPlayers(this.deps.now());
      this.maybeArmAwaySweep();
    }, period);
  }

  private onConnected(userId: string, connected: boolean): void {
    const seat = this.seatOf(userId);
    if (seat === null) return;
    const entry = this.roster.get(seat);
    if (!entry || entry.connected === connected) return;
    entry.connected = connected;

    if (connected) {
      entry.awaySince = null;
      entry.missedHands = 0;
    } else {
      entry.awaySince = this.deps.now();
      this.maybeArmAwaySweep();
    }

    // Keep the acting player's clock in step with their connection: a returning
    // player gets the full action timeout back; one who just dropped is put on
    // the short grace clock. Also (re)starts a clock that snapshot recovery
    // deliberately left unarmed until someone came back.
    const handLive = this.state.street !== Street.Waiting && this.state.street !== Street.Complete;
    if (handLive && this.state.actingSeat === seat) {
      this.armActionTimer();
    } else if (
      handLive &&
      this.state.actingSeat !== null &&
      this.actionTimer === null &&
      connected
    ) {
      this.armActionTimer();
    }

    this.deps.notify({ kind: 'state' });
  }

  private onSit(userId: string, sittingOut: boolean): void {
    const seat = this.seatOf(userId);
    if (seat === null) return;
    const entry = this.roster.get(seat);
    if (!entry) return;
    entry.sittingOut = sittingOut;
    // Pause/resume the time-charge clock at the seat, not the wall clock: sit
    // out and the elapsed-since-last-charge mark freezes (applyTimeCharges
    // already skips sitting-out seats); return and it restarts from now, so a
    // long break never turns into a surprise charge for time not played.
    entry.lastTimeChargeAt = this.deps.now();
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
    // A still-disconnected player who just timed out is parked as sitting-out so
    // the table stops dealing them in (and burning a grace clock) every hand.
    // They clear it themselves with "sit in" once they're back.
    const entry = this.roster.get(seat);
    if (entry && !entry.connected && !entry.pendingLeave) entry.sittingOut = true;
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

    // Count this hand against every away player, then stand up anyone who's now
    // over the away limit - before we work out who's eligible to be dealt in.
    const now = this.deps.now();
    for (const e of this.roster.values()) {
      if (e.connected) continue;
      if (e.awaySince === null) e.awaySince = now;
      e.missedHands += 1;
    }
    this.sweepAwayPlayers(now);

    const eligible = [...this.roster.entries()]
      .filter(([, e]) => !e.sittingOut && !e.pendingLeave && e.stack > 0)
      .sort(([a], [b]) => a - b);
    if (eligible.length < 2) {
      // No hand to deal - free any seats whose player asked to leave and credit
      // their stack back (they'd otherwise linger until a hand happens to run).
      this.releasePendingLeavers();
      return;
    }

    this.handNumber += 1;
    this.revealedSeats.clear();
    // Client action sequence numbers are per-hand; a rejoined client restarts
    // its counter, so a stale high-water mark would silently swallow its first
    // few actions of the new hand.
    this.lastSeqByUser.clear();

    // Bomb-pot decision (ADR-0026). Server-authoritative, computed once here from
    // the persisted completed-hand counter. NLHE cash only.
    this.currentHandIsBomb =
      this.meta.bombPotEnabled &&
      this.engineConfig.variant === GameVariant.Holdem &&
      this.handsSinceLastBomb + 1 >= this.bombInterval();
    this.currentBombAmount = this.currentHandIsBomb ? this.bombAmount() : 0;

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

    this.handLog = {
      startedAt: this.deps.now(),
      deck: [],
      prevPositions: this.previousPositions,
      seats: eligible.map(([seat, e]) => ({
        seat,
        userId: e.userId,
        username: e.username,
        startStack: e.stack,
      })),
      actions: [],
      bombPotAmount: this.currentBombAmount,
    };

    this.applyEngine({
      type: 'START_HAND',
      handId: randomUUID(),
      handNumber: this.handNumber,
      previousPositions: this.previousPositions,
      ...(this.currentHandIsBomb ? { bombPot: { amount: this.currentBombAmount } } : {}),
    });
    // Deck capture happens inside applyEngine (right after the state swap) so it
    // is recorded even when START_HAND runs straight to showdown - e.g. a bomb
    // pot where every dealt-in player is all-in from the contribution.
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

    // Capture the shuffled deal order the moment the engine produces it, before
    // an instant runout (all-in bomb pot / all-in blinds) can complete the hand
    // and clear the log.
    if (this.handLog && action.type === 'START_HAND') {
      this.handLog.deck = this.state.deck.cards.map(cardToString);
    }

    // record every accepted in-hand action for replay
    if (this.handLog && (action.type === 'PLAYER_ACTION' || action.type === 'TIMEOUT')) {
      this.handLog.actions.push(action);
    }

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
    this.previousPositions = previousPositionsOf(this.state);
    const potTotal = this.state.pots.reduce((sum, pot) => sum + pot.amount, 0);
    this.deps.recordHandStats(potTotal);
    this.persistCompletedHand(potTotal);
    for (const player of this.state.players) {
      const entry = this.roster.get(player.seatNumber);
      if (!entry) continue;
      entry.stack = player.stack;
      if (player.stack === 0) entry.sittingOut = true;
    }
    // Roster stacks now match the engine - safe to cash out anyone over the
    // away limit (rather than wait for the next hand that may never start).
    this.sweepAwayPlayers(this.deps.now());
    // Same reasoning: only safe to touch stacks between hands (see
    // sweepAwayPlayers' own note above it).
    this.applyTimeCharges(this.deps.now());
    this.releasePendingLeavers();

    // The ONE authoritative place a completed hand advances the bomb-pot
    // counter (ADR-0026): a bomb pot resets it to 0, any other completed hand
    // adds 1. Nothing else - not the reducer, a socket callback, reconnect, or
    // recovery - touches it. Done before `persistRoster` / `notify` so the
    // persisted counter (PokerTable + Redis snapshot) is the advanced value.
    if (this.meta.bombPotEnabled) {
      this.handsSinceLastBomb = this.currentHandIsBomb ? 0 : this.handsSinceLastBomb + 1;
    }
    this.currentHandIsBomb = false;
    this.currentBombAmount = 0;

    this.deps.persistRoster(this);
    this.deps.notify({ kind: 'handComplete' });
    this.scheduleNextHand();
  }

  private persistCompletedHand(potTotal: number): void {
    const log = this.handLog;
    this.handLog = null;
    if (!log) return;

    const results = this.state.players.map((p) => {
      const start = log.seats.find((s) => s.seat === p.seatNumber);
      const startStack = start?.startStack ?? p.stack;
      return {
        seat: p.seatNumber,
        userId: p.userId,
        net: p.stack - startStack,
        endStack: p.stack,
      };
    });

    this.deps.recordHand({
      engineHandId: this.state.handId,
      handNumber: this.handNumber,
      startedAt: log.startedAt,
      endedAt: this.deps.now(),
      deck: log.deck,
      buttonSeat: this.state.buttonSeat,
      smallBlindSeat: this.state.smallBlindSeat,
      bigBlindSeat: this.state.bigBlindSeat,
      prevPositions: log.prevPositions,
      seats: log.seats,
      actions: log.actions,
      board: this.state.communityCards.map(cardToString),
      results,
      potTotal,
      bombPotAmount: log.bombPotAmount,
    });
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
    // A player who is gone - socket dropped, or asked to leave mid-hand - gets a
    // much shorter clock so the table isn't held hostage while they're away.
    const entry = this.roster.get(seat);
    const away = entry !== undefined && (!entry.connected || entry.pendingLeave);
    const timeoutMs = away
      ? Math.min(this.deps.config.disconnectGraceMs, this.deps.config.actionTimeoutMs)
      : this.deps.config.actionTimeoutMs;
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
    if (this.awayTimer !== null) {
      this.deps.timers.clear(this.awayTimer);
      this.awayTimer = null;
    }
  }
}
