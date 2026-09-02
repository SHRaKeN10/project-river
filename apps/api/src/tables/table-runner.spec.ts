import { createTableConfig, fold, PlayerStatus, SeededRandomProvider } from '@river/poker-engine';
import type { GameEvent } from '@river/poker-engine';
import type { TableMeta } from './table-projection';
import {
  type RunnerDeps,
  type RunnerNotification,
  type TimerScheduler,
  TableRunner,
} from './table-runner';

class FakeTimers implements TimerScheduler {
  private jobs = new Map<number, () => void>();
  private id = 0;
  set(fn: () => void): number {
    const id = (this.id += 1);
    this.jobs.set(id, fn);
    return id;
  }
  clear(handle: unknown): void {
    this.jobs.delete(handle as number);
  }
  /** Fire exactly the timers pending right now (not ones they schedule). */
  runPending(): void {
    const fns = [...this.jobs.values()];
    this.jobs.clear();
    for (const fn of fns) fn();
  }
  /** Fire timers repeatedly until none remain. */
  runUntilIdle(): void {
    for (let i = 0; i < 50 && this.jobs.size > 0; i += 1) this.runPending();
  }
  get pending(): number {
    return this.jobs.size;
  }
}

const meta: TableMeta = {
  id: 't-1',
  name: 'T',
  gameType: 'NLHE',
  smallBlind: 10,
  bigBlind: 20,
  maxSeats: 6,
  minBuyIn: 400,
  maxBuyIn: 4000,
};

function harness(seed = 7) {
  const notifications: RunnerNotification[] = [];
  const vacated: { userId: string; stack: number }[] = [];
  const timers = new FakeTimers();
  const deps: RunnerDeps = {
    rng: new SeededRandomProvider(seed),
    timers,
    now: () => 1_000_000,
    config: {
      actionTimeoutMs: 1000,
      nextHandDelayMs: 500,
      startDelayMs: 100,
      disconnectGraceMs: 200,
    },
    notify: (n) => notifications.push(n),
    persistRoster: () => undefined,
    onSeatVacated: (userId, stack) => vacated.push({ userId, stack }),
    recordHandStats: () => undefined,
  };
  const runner = new TableRunner(
    meta,
    createTableConfig({ smallBlind: 10, bigBlind: 20, maxSeats: 6 }),
    deps,
  );
  const join = (userId: string, seat: number, stack = 1000) =>
    runner.join({
      userId,
      username: userId,
      avatarUrl: null,
      seatNumber: seat,
      stack,
      connected: true,
    });
  const events = () =>
    notifications
      .filter((n): n is Extract<RunnerNotification, { kind: 'events' }> => n.kind === 'events')
      .flatMap((n) => n.events);
  const eventTypes = () => events().map((e: GameEvent) => e.type);
  const rosterTotal = () => [...runner.rosterEntries.values()].reduce((t, e) => t + e.stack, 0);

  return { runner, notifications, vacated, timers, join, events, eventTypes, rosterTotal };
}

describe('TableRunner', () => {
  it('auto-starts a hand once two funded players are seated', () => {
    const h = harness();
    h.join('alice', 0);
    h.join('bob', 1);
    expect(h.runner.gameState.street).toBe('WAITING');

    h.timers.runPending(); // fire the start-delay timer

    expect(h.eventTypes()).toContain('HAND_STARTED');
    expect(h.runner.gameState.street).toBe('PREFLOP');
    expect(h.runner.gameState.actingSeat).not.toBeNull();
    expect(h.rosterTotal()).toBe(2000);
  });

  it('plays a fold-out hand and conserves chips', () => {
    const h = harness();
    h.join('alice', 0);
    h.join('bob', 1);
    h.timers.runPending();

    const state = h.runner.gameState;
    const actingUser = [...h.runner.rosterEntries.entries()].find(
      ([seat]) => seat === state.actingSeat,
    )![1].userId;

    h.runner.submitAction(actingUser, state.handId, 1, fold());

    expect(h.eventTypes()).toContain('HAND_COMPLETED');
    expect(h.runner.gameState.street).toBe('COMPLETE');
    expect(h.rosterTotal()).toBe(2000);
    // winner gained the small blind, loser lost it
    const stacks = [...h.runner.rosterEntries.values()].map((e) => e.stack).sort((a, b) => a - b);
    expect(stacks).toEqual([990, 1010]);
  });

  it('rejects an action from the wrong player', () => {
    const h = harness();
    h.join('alice', 0);
    h.join('bob', 1);
    h.timers.runPending();

    const state = h.runner.gameState;
    const wrongUser = [...h.runner.rosterEntries.entries()].find(
      ([seat]) => seat !== state.actingSeat,
    )![1].userId;

    h.runner.submitAction(wrongUser, state.handId, 1, fold());
    expect(h.notifications.some((n) => n.kind === 'rejected')).toBe(true);
    expect(h.runner.gameState.street).toBe('PREFLOP');
  });

  it('ignores a duplicate clientSeq', () => {
    const h = harness();
    h.join('alice', 0);
    h.join('bob', 1);
    h.timers.runPending();
    const state = h.runner.gameState;
    const actingUser = [...h.runner.rosterEntries.entries()].find(
      ([seat]) => seat === state.actingSeat,
    )![1].userId;

    h.runner.submitAction(actingUser, state.handId, 5, fold());
    const completedOnce = h.eventTypes().filter((t) => t === 'HAND_COMPLETED').length;
    h.runner.submitAction(actingUser, state.handId, 5, fold()); // same seq -> ignored
    expect(h.eventTypes().filter((t) => t === 'HAND_COMPLETED').length).toBe(completedOnce);
  });

  it('auto-acts on action-timer expiry and keeps auto-playing without losing chips', () => {
    const h = harness();
    h.join('alice', 0);
    h.join('bob', 1);
    h.timers.runUntilIdle(); // start hand -> action timer fires -> next hand -> ...

    expect(h.eventTypes()).toEqual(expect.arrayContaining(['ACTION_TIMED_OUT', 'HAND_COMPLETED']));
    expect(h.rosterTotal()).toBe(2000); // chip total is invariant across every auto-played hand
    for (const entry of h.runner.rosterEntries.values())
      expect(entry.stack).toBeGreaterThanOrEqual(0);
  });

  it('lets a player leave between hands and vacates their seat', () => {
    const h = harness();
    h.join('alice', 0);
    h.join('bob', 1);
    // no hand started yet (timer not fired)
    h.runner.leave('alice');
    expect(h.runner.seatOf('alice')).toBeNull();
    expect(h.vacated).toEqual([{ userId: 'alice', stack: 1000 }]);
  });

  it('a disconnected player is auto-folded on their timer and the hand continues', () => {
    const h = harness();
    h.join('alice', 0);
    h.join('bob', 1);
    h.join('cara', 2);
    h.timers.runPending(); // start the hand
    expect(h.runner.gameState.street).toBe('PREFLOP');

    const actingSeat = h.runner.gameState.actingSeat!;
    const actingUser = [...h.runner.rosterEntries.entries()].find(([s]) => s === actingSeat)![1]
      .userId;

    h.runner.setConnected(actingUser, false); // they drop
    h.timers.runPending(); // their action timer fires -> TIMEOUT -> fold

    expect(h.eventTypes()).toEqual(expect.arrayContaining(['ACTION_TIMED_OUT', 'PLAYER_FOLDED']));
    const folded = h.runner.gameState.players.find((p) => p.seatNumber === actingSeat);
    expect(folded?.status).toBe(PlayerStatus.Folded);
    expect(h.runner.rosterEntries.get(actingSeat)?.connected).toBe(false);
    expect(h.rosterTotal()).toBe(3000);
  });

  it('puts the acting player on the short grace clock when they drop, and restores it on return', () => {
    const h = harness(); // actionTimeoutMs 1000, disconnectGraceMs 200, now() = 1_000_000
    h.join('alice', 0);
    h.join('bob', 1);
    h.timers.runPending();

    const actingSeat = h.runner.gameState.actingSeat!;
    const actingUser = [...h.runner.rosterEntries.entries()].find(([s]) => s === actingSeat)![1]
      .userId;
    expect(h.runner.gameState.actionDeadline).toBe(1_000_000 + 1000);

    h.runner.setConnected(actingUser, false);
    expect(h.runner.gameState.actionDeadline).toBe(1_000_000 + 200); // grace clock

    h.runner.setConnected(actingUser, true);
    expect(h.runner.gameState.actionDeadline).toBe(1_000_000 + 1000); // full clock back
  });

  it('re-arms the action timer once a player reconnects after snapshot recovery', () => {
    const original = harness();
    original.join('alice', 0);
    original.join('bob', 1);
    original.join('cara', 2);
    original.timers.runPending();

    const snapshot = {
      state: JSON.parse(JSON.stringify(original.runner.gameState)),
      handNumber: original.runner.lastHandNumber,
      previousPositions: original.runner.lastPositions,
      roster: [...original.runner.rosterEntries.entries()].map(([seatNumber, e]) => ({
        seatNumber,
        userId: e.userId,
        username: e.username,
        avatarUrl: e.avatarUrl,
        stack: e.stack,
        sittingOut: e.sittingOut,
      })),
    };

    const revived = harness();
    revived.runner.hydrateFromSnapshot(
      snapshot,
      new Map(
        snapshot.roster.map((r) => [r.userId, { username: r.username, avatarUrl: r.avatarUrl }]),
      ),
    );
    // recovery deliberately leaves the clock unarmed until someone is back
    expect(revived.timers.pending).toBe(0);

    const actingSeat = revived.runner.gameState.actingSeat!;
    const actingUser = snapshot.roster.find((r) => r.seatNumber === actingSeat)!.userId;
    revived.runner.setConnected(actingUser, true);

    expect(revived.timers.pending).toBeGreaterThan(0);
    expect(revived.runner.gameState.actionDeadline).not.toBeNull();
  });

  it('reconnect restores the connected flag mid-hand', () => {
    const h = harness();
    h.join('alice', 0);
    h.join('bob', 1);
    h.timers.runPending();

    h.runner.setConnected('alice', false);
    expect(h.runner.rosterEntries.get(0)?.connected).toBe(false);
    h.runner.setConnected('alice', true);
    expect(h.runner.rosterEntries.get(0)?.connected).toBe(true);
  });

  it('hydrateFromSnapshot reconstructs an in-progress hand that can be played to the end', () => {
    // play a few actions on the first runner
    const original = harness();
    original.join('alice', 0);
    original.join('bob', 1);
    original.join('cara', 2);
    original.timers.runPending();
    original.runner.submitAction(
      seatUser(original.runner, original.runner.gameState.actingSeat!),
      original.runner.gameState.handId,
      1,
      { type: 'CALL' },
    );

    const snapshot = {
      state: JSON.parse(JSON.stringify(original.runner.gameState)),
      handNumber: original.runner.lastHandNumber,
      previousPositions: original.runner.lastPositions,
      roster: [...original.runner.rosterEntries.entries()].map(([seatNumber, e]) => ({
        seatNumber,
        userId: e.userId,
        username: e.username,
        avatarUrl: e.avatarUrl,
        stack: e.stack,
        sittingOut: e.sittingOut,
      })),
    };

    // rebuild a fresh runner from the snapshot (simulating an API restart)
    const revived = harness();
    revived.runner.hydrateFromSnapshot(
      snapshot,
      new Map(
        snapshot.roster.map((r) => [r.userId, { username: r.username, avatarUrl: r.avatarUrl }]),
      ),
    );

    expect(revived.runner.gameState.street).toBe(original.runner.gameState.street);
    expect(revived.runner.gameState.handId).toBe(original.runner.gameState.handId);
    expect(revived.runner.seatedCount).toBe(3);

    // players reconnect and finish the hand
    for (const seat of [0, 1, 2]) revived.runner.setConnected(seatUser(revived.runner, seat), true);
    let guard = 0;
    while (revived.runner.gameState.street !== 'COMPLETE' && (guard += 1) < 50) {
      const seat = revived.runner.gameState.actingSeat;
      if (seat === null) break;
      const owed =
        revived.runner.gameState.round.currentBet -
        (revived.runner.gameState.players.find((p) => p.seatNumber === seat)?.currentBet ?? 0);
      revived.runner.submitAction(
        seatUser(revived.runner, seat),
        revived.runner.gameState.handId,
        guard + 10,
        owed > 0 ? { type: 'CALL' } : { type: 'CHECK' },
      );
    }
    expect(revived.runner.gameState.street).toBe('COMPLETE');
    expect([...revived.runner.rosterEntries.values()].reduce((t, e) => t + e.stack, 0)).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// closed-alpha audit regressions
// ---------------------------------------------------------------------------

describe('TableRunner - closed-alpha regressions', () => {
  const drivePlayHand = (runner: TableRunner, startSeq: number): number => {
    let seq = startSeq;
    let guard = 0;
    while (runner.gameState.street !== 'COMPLETE' && (guard += 1) < 40) {
      const seat = runner.gameState.actingSeat;
      if (seat === null) break;
      const p = runner.gameState.players.find((x) => x.seatNumber === seat);
      const owed = runner.gameState.round.currentBet - (p?.currentBet ?? 0);
      runner.submitAction(
        seatUser(runner, seat),
        runner.gameState.handId,
        (seq += 1),
        owed > 0 ? { type: 'CALL' } : { type: 'CHECK' },
      );
    }
    return seq;
  };

  it('join() reports SEAT_TAKEN / BAD_BUY_IN synchronously (so the gateway can refund)', () => {
    const h = harness();
    expect(h.join('alice', 0, 1000)).toEqual({ ok: true });
    expect(h.join('bob', 0, 1000)).toEqual({
      ok: false,
      code: 'SEAT_TAKEN',
      reason: expect.any(String),
    });
    expect(h.join('cara', 1, 999_999)).toMatchObject({ ok: false, code: 'BAD_BUY_IN' });
    expect(h.join('dan', 99, 1000)).toMatchObject({ ok: false, code: 'BAD_SEAT' });
  });

  it('resets the action-sequence high-water mark per hand (a rejoined client uses low seqs)', () => {
    const h = harness();
    h.join('alice', 0);
    h.join('bob', 1);
    h.timers.runPending(); // hand 1

    drivePlayHand(h.runner, 0); // drives clientSeq 1..~5 for both users
    expect(h.runner.gameState.street).toBe('COMPLETE');

    h.timers.runPending(); // next-hand delay -> hand 2

    // hand 2: both clients "rejoined", so their seq restarts at 1.
    const before = h.eventTypes().filter((t) => t === 'HAND_COMPLETED').length;
    drivePlayHand(h.runner, 0);
    expect(h.runner.gameState.street).toBe('COMPLETE');
    expect(h.eventTypes().filter((t) => t === 'HAND_COMPLETED').length).toBe(before + 1);
    expect(h.rosterTotal()).toBe(2000);
  });

  it('parks a disconnected player as sitting-out after they time out', () => {
    const h = harness();
    h.join('alice', 0);
    h.join('bob', 1);
    h.join('cara', 2);
    h.timers.runPending();

    const seat = h.runner.gameState.actingSeat!;
    const user = seatUser(h.runner, seat);
    h.runner.setConnected(user, false);
    h.timers.runPending(); // grace timer fires -> TIMEOUT

    expect(h.runner.rosterEntries.get(seat)?.sittingOut).toBe(true);

    // and they are not dealt into the following hand
    h.timers.runUntilIdle();
    const dealtSeats = h.runner.gameState.players.map((p) => p.seatNumber);
    expect(dealtSeats).not.toContain(seat);
  });

  it('frees a pending-leave seat (crediting the stack) when the table cannot start a hand', () => {
    const h = harness();
    h.join('alice', 0);
    h.join('bob', 1);
    h.timers.runPending(); // hand in progress

    // bob asks to leave mid-hand while it is NOT his turn -> pending
    const actingSeat = h.runner.gameState.actingSeat!;
    const other = actingSeat === 0 ? 'bob' : 'alice';
    const otherSeat = other === 'bob' ? 1 : 0;
    h.runner.leave(other);
    expect(h.runner.seatOf(other)).not.toBeNull(); // still seated (pending)

    h.timers.runUntilIdle(); // hand finishes; only 1 player left -> can't start
    expect(h.runner.seatOf(other)).toBeNull(); // seat freed
    expect(h.vacated.map((v) => v.userId)).toContain(other);
    void otherSeat;
  });
});

function seatUser(runner: TableRunner, seat: number): string {
  for (const [s, entry] of runner.rosterEntries) if (s === seat) return entry.userId;
  throw new Error(`no user at seat ${seat}`);
}
