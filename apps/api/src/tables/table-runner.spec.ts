import {
  cardToString,
  createTableConfig,
  fold,
  parseCard,
  PlayerStatus,
  replayHand,
  SeededRandomProvider,
} from '@river/poker-engine';
import type { GameEvent } from '@river/poker-engine';
import type { TableMeta } from './table-projection';
import {
  type CompletedHand,
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
  timeChargeAmount: 0,
  timeChargeIntervalMs: 0,
  bombPotEnabled: false,
  bombPotIntervalHands: 15,
  bombPotAmount: 0,
};

function harness(seed = 7, metaOverrides: Partial<TableMeta> = {}) {
  const notifications: RunnerNotification[] = [];
  const vacated: { userId: string; seatNumber: number; stack: number; idemKey: string }[] = [];
  const hands: CompletedHand[] = [];
  const charged: { userId: string; seatNumber: number; amount: number; idemKey: string }[] = [];
  const timers = new FakeTimers();
  const clock = { ms: 1_000_000 };
  const advance = (ms: number): void => {
    clock.ms += ms;
  };
  const deps: RunnerDeps = {
    rng: new SeededRandomProvider(seed),
    timers,
    now: () => clock.ms,
    config: {
      actionTimeoutMs: 1000,
      nextHandDelayMs: 500,
      startDelayMs: 100,
      disconnectGraceMs: 200,
      awayMaxMs: 10_000,
      awayMaxMissedHands: 3,
    },
    notify: (n) => notifications.push(n),
    persistRoster: () => undefined,
    onSeatVacated: (v) => vacated.push(v),
    recordHandStats: () => undefined,
    recordHand: (h) => hands.push(h),
    chargeAccount: (c) => charged.push(c),
  };
  const runner = new TableRunner(
    { ...meta, ...metaOverrides },
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
  const timeCharges = () =>
    notifications.filter(
      (n): n is Extract<RunnerNotification, { kind: 'timeCharge' }> => n.kind === 'timeCharge',
    );

  return {
    runner,
    notifications,
    vacated,
    hands,
    charged,
    timers,
    advance,
    join,
    events,
    eventTypes,
    rosterTotal,
    timeCharges,
  };
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
    expect(h.vacated).toEqual([
      { userId: 'alice', seatNumber: 0, stack: 1000, idemKey: expect.any(String) },
    ]);
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
    // recovery deliberately leaves the action clock unarmed until someone is back
    expect(revived.runner.gameState.actionDeadline).toBeNull();

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

  it('records each completed hand with everything replayHand needs to reproduce it', () => {
    const h = harness();
    h.join('alice', 0);
    h.join('bob', 1);
    h.join('cara', 2);
    h.timers.runPending(); // hand 1
    drivePlayHand(h.runner, 0);
    h.timers.runPending(); // hand 2 (so prevPositions is non-null)
    drivePlayHand(h.runner, 0);

    expect(h.hands).toHaveLength(2);
    const [, second] = h.hands;
    expect(second.prevPositions).not.toBeNull();
    expect(second.deck).toHaveLength(52);
    expect(second.seats.length).toBeGreaterThanOrEqual(2);

    // the persisted record replays to the same board and net result
    const replayed = replayHand({
      tableId: 't-1',
      config: createTableConfig({ smallBlind: 10, bigBlind: 20, maxSeats: 6 }),
      seats: second.seats.map((s) => ({
        userId: s.userId,
        seatNumber: s.seat,
        stack: s.startStack,
      })),
      handId: second.engineHandId,
      handNumber: second.handNumber,
      previousPositions: second.prevPositions,
      deck: second.deck.map(parseCard),
      actions: second.actions,
    });
    expect(replayed.state.communityCards.map(cardToString)).toEqual(second.board);
    for (const r of second.results) {
      const p = replayed.state.players.find((x) => x.seatNumber === r.seat);
      expect(p?.stack).toBe(r.endStack);
    }
  });

  it('stands up a long-disconnected player, returning their chips', () => {
    const h = harness(); // awayMaxMissedHands: 3
    h.join('alice', 0);
    h.join('bob', 1);
    h.join('cara', 2);
    h.timers.runPending(); // hand 1 starts (all three connected)

    h.runner.setConnected('cara', false); // cara's socket drops mid-hand
    h.timers.runUntilIdle(); // hands play out; cara keeps missing them

    expect(h.runner.seatOf('cara')).toBeNull();
    const caraVacate = h.vacated.find((v) => v.userId === 'cara');
    expect(caraVacate?.idemKey).toMatch(/^away:/);
    expect(
      h.notifications.some(
        (n) => n.kind === 'rejected' && n.userId === 'cara' && n.code === 'REMOVED_INACTIVE',
      ),
    ).toBe(true);
    // no chips vanished: what's left on the table + what cara took back == 3000
    const onTable = [...h.runner.rosterEntries.values()].reduce((t, e) => t + e.stack, 0);
    expect(onTable + (caraVacate?.stack ?? 0)).toBe(3000);
  });

  it('does not mint chips when the away timer fires during a live hand', () => {
    const h = harness();
    h.join('alice', 0);
    h.join('bob', 1);
    h.join('cara', 2);
    h.timers.runPending(); // start hand 1 - cara is dealt in and posts chips
    expect(h.runner.handInProgress).toBe(true);

    h.runner.setConnected('cara', false); // drops with chips committed
    h.advance(11_000); // past awayMaxMs (10_000) -> "tooLong" is now true

    // Fire every timer. The away sweep must not cash cara out mid-hand against
    // her stale pre-hand stack while her committed chips are still in the pot;
    // it waits until the hand settles.
    h.timers.runUntilIdle();

    const total = h.rosterTotal() + h.vacated.reduce((t, v) => t + v.stack, 0);
    expect(total).toBe(3000); // chip conservation held
    expect(h.runner.seatOf('cara')).toBeNull(); // still eventually removed
  });

  it('bills the wallet (not the stack) once the time-charge interval has elapsed', () => {
    const h = harness(7, { timeChargeAmount: 5, timeChargeIntervalMs: 1000 });
    h.join('alice', 0);
    h.join('bob', 1);
    h.timers.runPending(); // hand starts

    const state = h.runner.gameState;
    const actingUser = [...h.runner.rosterEntries.entries()].find(
      ([seat]) => seat === state.actingSeat,
    )![1].userId;

    h.advance(1000); // exactly one interval since both seats joined
    h.runner.submitAction(actingUser, state.handId, 1, fold());

    const charges = h.timeCharges();
    expect(charges).toHaveLength(2); // one per seated player, win or lose
    expect(charges.every((c) => c.amount === 5)).toBe(true);
    expect(h.charged).toHaveLength(2);
    expect(h.charged.every((c) => c.amount === 5 && c.idemKey.startsWith('timecharge:'))).toBe(
      true,
    );
    // the fold moved the blind between the two - the table's own stack total
    // is untouched by the charge, because it's billed against the wallet.
    expect(h.rosterTotal()).toBe(2000);
  });

  it('never touches a seat or stack, even for a charge bigger than any stack', () => {
    const h = harness(7, { timeChargeAmount: 999_999, timeChargeIntervalMs: 1000 });
    h.join('alice', 0);
    h.join('bob', 1);
    h.timers.runPending();

    const state = h.runner.gameState;
    const actingUser = [...h.runner.rosterEntries.entries()].find(
      ([seat]) => seat === state.actingSeat,
    )![1].userId;

    h.advance(1000);
    h.runner.submitAction(actingUser, state.handId, 1, fold());

    // The runner never learns whether chargeAccount actually succeeded (it's
    // fire-and-forget against the wallet), so it can't and doesn't act on an
    // oversized charge - both seats stay exactly as the hand left them.
    expect(h.runner.rosterEntries.size).toBe(2);
    expect(h.vacated).toHaveLength(0);
    expect(h.rosterTotal()).toBe(2000);
    expect(h.charged).toHaveLength(2);
    expect(h.charged.every((c) => c.amount === 999_999)).toBe(true);
  });

  it('catches up on several missed intervals at once for an idle table', () => {
    const h = harness(7, { timeChargeAmount: 5, timeChargeIntervalMs: 1000 });
    h.join('alice', 0);
    h.join('bob', 1);
    h.timers.runPending();

    const state = h.runner.gameState;
    const actingUser = [...h.runner.rosterEntries.entries()].find(
      ([seat]) => seat === state.actingSeat,
    )![1].userId;

    h.advance(3_000); // three intervals elapsed before this hand settles
    h.runner.submitAction(actingUser, state.handId, 1, fold());

    // 2 seats x 3 owed intervals = 6 charges, each with its own idemKey.
    expect(h.charged).toHaveLength(6);
    expect(new Set(h.charged.map((c) => c.idemKey)).size).toBe(6);
  });

  it('pauses the time-charge clock while a seat sits out', () => {
    const h = harness(7, { timeChargeAmount: 5, timeChargeIntervalMs: 1000 });
    h.join('alice', 0);
    h.join('bob', 1);
    h.timers.runPending();
    h.runner.setSittingOut('bob', true);

    const state = h.runner.gameState;
    const actingUser = [...h.runner.rosterEntries.entries()].find(
      ([seat]) => seat === state.actingSeat,
    )![1].userId;

    h.advance(1000);
    h.runner.submitAction(actingUser, state.handId, 1, fold());

    // alice is charged for the elapsed interval; bob, sitting out the whole
    // time, isn't.
    expect(h.charged.map((c) => c.userId)).toEqual(['alice']);
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

// ---------------------------------------------------------------------------
// bomb pots (ADR-0026)
// ---------------------------------------------------------------------------

describe('TableRunner - bomb pots', () => {
  const drive = (runner: TableRunner, startSeq = 0): number => {
    let seq = startSeq;
    let guard = 0;
    while (runner.gameState.street !== 'COMPLETE' && (guard += 1) < 60) {
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

  /** Play a whole hand then let the next-hand delay fire. */
  const nextHand = (h: ReturnType<typeof harness>, seq = 0): number => {
    const s = drive(h.runner, seq);
    h.timers.runPending();
    return s;
  };

  it('never schedules a bomb pot on a table that has the feature disabled', () => {
    const h = harness(7); // meta default: bombPotEnabled false
    h.join('alice', 0);
    h.join('bob', 1);
    h.timers.runPending();
    for (let i = 0; i < 20; i += 1) nextHand(h);
    expect(h.runner.bombHandCounter).toBe(0);
    expect(h.eventTypes()).not.toContain('BOMB_POT_STARTED');
    expect(h.runner.bombPotView()).toBeNull();
  });

  it('advances the counter by exactly one per completed non-bomb hand', () => {
    const h = harness(7, { bombPotEnabled: true, bombPotIntervalHands: 15 });
    h.join('alice', 0);
    h.join('bob', 1);
    h.timers.runPending();
    for (let n = 1; n <= 5; n += 1) {
      expect(h.runner.bombHandCounter).toBe(n - 1);
      nextHand(h);
      expect(h.runner.bombHandCounter).toBe(n);
    }
  });

  it('makes every Nth hand a bomb pot: no blinds, straight to the flop, counter resets', () => {
    const h = harness(7, { bombPotEnabled: true, bombPotIntervalHands: 3 });
    h.join('alice', 0);
    h.join('bob', 1);
    h.join('cara', 2);
    h.timers.runPending();

    nextHand(h); // drive hand 1 -> counter 1, hand 2 dealt
    expect(h.runner.bombHandCounter).toBe(1);
    expect(h.runner.bombPotView()).toMatchObject({ active: false, nextInHands: 2 });

    nextHand(h); // drive hand 2 -> counter 2, hand 3 (the bomb) dealt
    expect(h.runner.gameState.street).toBe('FLOP');
    expect(h.runner.bombPotView()).toMatchObject({ active: true, amount: 20, nextInHands: 0 });

    const bombEvents = h
      .events()
      .slice(-12)
      .map((e) => e.type);
    expect(bombEvents).toContain('BOMB_POT_STARTED');
    expect(bombEvents).toContain('BOMB_POT_POSTED');

    // every dealt-in player put in the bomb, nobody posted a blind this hand
    const posted = h.events().filter((e) => e.type === 'BOMB_POT_POSTED').length;
    expect(posted).toBe(3);

    const potAfterContrib = h.runner.gameState.players.reduce((t, p) => t + p.totalInvested, 0);
    expect(potAfterContrib).toBe(60);

    nextHand(h); // finish the bomb pot
    expect(h.runner.bombHandCounter).toBe(0); // reset
  });

  it('conserves chips through a bomb-pot hand', () => {
    const h = harness(11, { bombPotEnabled: true, bombPotIntervalHands: 2 });
    h.join('alice', 0, 1000);
    h.join('bob', 1, 1000);
    h.join('cara', 2, 1000);
    h.timers.runPending();
    nextHand(h); // hand 1
    expect(h.runner.gameState.street).toBe('FLOP'); // hand 2 = bomb
    nextHand(h);
    expect(h.rosterTotal()).toBe(3000);
  });

  it('still records a replayable deck when a bomb pot runs straight to showdown (all short)', () => {
    // Every dealt-in player is all-in from the bomb, so START_HAND runs the
    // whole board out and completes the hand in one reduce() call.
    const h = harness(11, {
      bombPotEnabled: true,
      bombPotIntervalHands: 1,
      bombPotAmount: 5000, // larger than any legal stack -> everyone all-in
    });
    h.join('alice', 0, 1000);
    h.join('bob', 1, 1000);
    h.timers.runPending();

    expect(h.runner.gameState.street).toBe('COMPLETE');
    expect(h.hands).toHaveLength(1);
    expect(h.hands[0].bombPotAmount).toBe(5000);
    expect(h.hands[0].deck.length).toBe(52);
    expect(h.rosterTotal()).toBe(2000);

    // the recorded hand replays bit-identically
    const rec = h.hands[0];
    const replayed = replayHand({
      tableId: 't-1',
      config: createTableConfig({ smallBlind: 10, bigBlind: 20, maxSeats: 6 }),
      seats: rec.seats.map((s) => ({
        userId: s.userId,
        seatNumber: s.seat,
        stack: s.startStack,
      })),
      handId: rec.engineHandId,
      handNumber: rec.handNumber,
      previousPositions: rec.prevPositions,
      deck: rec.deck.map(parseCard),
      actions: rec.actions,
      bombPot: { amount: rec.bombPotAmount },
    });
    expect(replayed.state.communityCards.map(cardToString)).toEqual(rec.board);
  });

  it('records bombPotAmount on the completed hand (0 for a normal hand)', () => {
    const h = harness(7, { bombPotEnabled: true, bombPotIntervalHands: 2 });
    h.join('alice', 0);
    h.join('bob', 1);
    h.timers.runPending();
    nextHand(h); // hand 1, normal
    nextHand(h); // hand 2, bomb
    const [firstHand, bombHand] = h.hands;
    expect(firstHand.bombPotAmount).toBe(0);
    expect(bombHand.bombPotAmount).toBe(20);
  });

  it('carries the counter across a cold restart (hydrate)', () => {
    const revived = harness(7, { bombPotEnabled: true, bombPotIntervalHands: 5 });
    revived.runner.hydrate(
      [
        { seatNumber: 0, userId: 'alice', stack: 1000, sittingOut: false },
        { seatNumber: 1, userId: 'bob', stack: 1000, sittingOut: false },
      ],
      new Map([
        ['alice', { username: 'alice', avatarUrl: null }],
        ['bob', { username: 'bob', avatarUrl: null }],
      ]),
      12,
      null,
      4,
    );
    expect(revived.runner.bombHandCounter).toBe(4);
    expect(revived.runner.bombPotView()).toMatchObject({ active: false, nextInHands: 1 });
    // the next dealt hand is the bomb pot (4 + 1 >= 5)
    for (const s of [0, 1]) revived.runner.setConnected(seatUser(revived.runner, s), true);
    revived.runner.requestStart();
    revived.timers.runPending();
    expect(revived.runner.gameState.street).toBe('FLOP');
    expect(revived.runner.bombPotView()).toMatchObject({ active: true });
  });

  it('carries the counter across a warm restart (hydrateFromSnapshot)', () => {
    const original = harness(7, { bombPotEnabled: true, bombPotIntervalHands: 15 });
    original.join('alice', 0);
    original.join('bob', 1);
    original.timers.runPending();
    nextHand(original);
    nextHand(original);
    nextHand(original);
    const counter = original.runner.bombHandCounter;
    expect(counter).toBe(3);

    const snapshot = {
      state: JSON.parse(JSON.stringify(original.runner.gameState)),
      handNumber: original.runner.lastHandNumber,
      previousPositions: original.runner.lastPositions,
      bombPot: original.runner.bombPotSnapshot(),
      roster: [...original.runner.rosterEntries.entries()].map(([seatNumber, e]) => ({
        seatNumber,
        userId: e.userId,
        username: e.username,
        avatarUrl: e.avatarUrl,
        stack: e.stack,
        sittingOut: e.sittingOut,
      })),
    };

    const revived = harness(7, { bombPotEnabled: true, bombPotIntervalHands: 15 });
    revived.runner.hydrateFromSnapshot(
      snapshot,
      new Map(
        snapshot.roster.map((r) => [r.userId, { username: r.username, avatarUrl: r.avatarUrl }]),
      ),
    );
    expect(revived.runner.bombHandCounter).toBe(counter);
  });
});

function seatUser(runner: TableRunner, seat: number): string {
  for (const [s, entry] of runner.rosterEntries) if (s === seat) return entry.userId;
  throw new Error(`no user at seat ${seat}`);
}
