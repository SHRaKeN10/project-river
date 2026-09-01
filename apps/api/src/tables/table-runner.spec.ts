import { createTableConfig, fold, SeededRandomProvider } from '@river/poker-engine';
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
    config: { actionTimeoutMs: 1000, nextHandDelayMs: 500, startDelayMs: 100 },
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
});
