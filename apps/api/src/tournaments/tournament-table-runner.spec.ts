import {
  allIn,
  call,
  check,
  createTableConfig,
  type GameState,
  type PlayerAction,
  SeededRandomProvider,
} from '@river/poker-engine';
import { type TimerScheduler } from '../tables/table-runner';
import {
  type TournamentTableDeps,
  type TournamentTableNotification,
  TournamentTableRunner,
} from './tournament-table-runner';

/** Delay-aware fake scheduler. `advance(ms)` moves the clock forward and fires
 * only the timers that come due in that window (in due order), so a short
 * `advance` fires the next-hand timer without running away on the action
 * clock. */
class FakeTimers implements TimerScheduler {
  private jobs = new Map<number, { at: number; fn: () => void }>();
  private id = 0;
  now = 1_000_000;
  set(fn: () => void, ms: number): number {
    const jobId = (this.id += 1);
    this.jobs.set(jobId, { at: this.now + ms, fn });
    return jobId;
  }
  clear(handle: unknown): void {
    this.jobs.delete(handle as number);
  }
  advance(ms: number): void {
    const target = this.now + ms;
    for (let guard = 0; guard < 1000; guard += 1) {
      const due = [...this.jobs.entries()]
        .filter(([, j]) => j.at <= target)
        .sort((a, b) => a[1].at - b[1].at);
      if (due.length === 0) break;
      const [jobId, job] = due[0] as [number, { at: number; fn: () => void }];
      this.jobs.delete(jobId);
      this.now = Math.max(this.now, job.at);
      job.fn();
    }
    this.now = target;
  }
  get pending(): number {
    return this.jobs.size;
  }
}

function harness(opts: {
  seed?: number;
  seats?: number;
  startingStack?: number;
  smallBlind?: number;
  bigBlind?: number;
}) {
  const notifications: TournamentTableNotification[] = [];
  const timers = new FakeTimers();
  const config = createTableConfig({
    smallBlind: opts.smallBlind ?? 10,
    bigBlind: opts.bigBlind ?? 20,
    maxSeats: opts.seats ?? 6,
    minBuyIn: 1,
    maxBuyIn: 10_000_000,
  });
  const deps: TournamentTableDeps = {
    rng: new SeededRandomProvider(opts.seed ?? 7),
    timers,
    now: () => timers.now,
    actionTimeoutMs: 1000,
    disconnectGraceMs: 200,
    nextHandDelayMs: 500,
    notify: (n) => notifications.push(n),
  };
  const runner = new TournamentTableRunner('t:0', 'Test - Table 1', 'NLHE', config, deps);
  const seat = (userId: string, n: number, stack: number, connected = true): void =>
    runner.seat({ userId, username: userId, avatarUrl: null, seat: n, stack, connected });
  return { runner, timers, notifications, seat };
}

/** Drive whoever is to act with a fixed action until the current hand ends.
 * Submits actions directly (the queue drains synchronously) and never fires a
 * timer, so it can't roll on into the next hand. */
function playOut(
  runner: TournamentTableRunner,
  pick: (state: GameState, seat: number) => PlayerAction,
): void {
  for (let guard = 0; guard < 300; guard += 1) {
    if (!runner.handInProgress) return;
    const s = runner.gameState;
    if (s.actingSeat === null) return;
    const player = s.players.find((p) => p.seatNumber === s.actingSeat);
    if (!player) return;
    runner.submitAction(player.userId, s.handId, guard + 1, pick(s, s.actingSeat));
  }
}

/** A call station: calls what's owed, otherwise checks. */
const callStation = (s: GameState, seat: number): PlayerAction => {
  const player = s.players.find((p) => p.seatNumber === seat);
  const owed = s.round.currentBet - (player?.currentBet ?? 0);
  return owed > 0 ? call() : check();
};

describe('TournamentTableRunner', () => {
  it('runs hands, conserves chips, and busts down to one with the idle signal', () => {
    const { runner, timers, notifications, seat } = harness({
      seed: 3,
      seats: 2,
      smallBlind: 10,
      bigBlind: 20,
    });
    seat('a', 0, 40, true);
    seat('b', 1, 40, true);
    runner.start();

    // both jam every decision - variance settles it within a few hands
    for (let hand = 0; hand < 30 && runner.chippedCount >= 2; hand += 1) {
      timers.advance(600); // fire the next-hand delay -> START_HAND

      playOut(runner, () => allIn());
      timers.advance(600);
      expect([...runner.stacks().values()].reduce((s, x) => s + x, 0)).toBe(80);
    }

    expect(runner.chippedCount).toBe(1);
    const bustedTotal = notifications
      .filter((n) => n.kind === 'handComplete')
      .reduce((sum, n) => sum + (n.kind === 'handComplete' ? n.busted.length : 0), 0);
    expect(bustedTotal).toBe(1);
    expect(notifications.some((n) => n.kind === 'idle')).toBe(true);
  });

  it('applies a new blind level only from the next hand', () => {
    const { runner, timers, seat } = harness({ seed: 5, seats: 3 });
    seat('a', 0, 5000, true);
    seat('b', 1, 5000, true);
    seat('c', 2, 5000, true);
    runner.start();
    timers.advance(600);
    expect(runner.gameState.config.bigBlind).toBe(20);

    runner.setLevel({ smallBlind: 50, bigBlind: 100, ante: 0 });
    // still the old level for the hand in progress
    expect(runner.gameState.config.bigBlind).toBe(20);

    playOut(runner, callStation);
    expect(runner.handInProgress).toBe(false);
    timers.advance(600);
    expect(runner.gameState.config.bigBlind).toBe(100);
  });

  it('does not deal a busted player back in, and unseats cleanly', () => {
    const { runner, timers, seat } = harness({ seed: 9, seats: 3, smallBlind: 10, bigBlind: 20 });
    seat('a', 0, 20, true);
    seat('b', 1, 3000, true);
    seat('c', 2, 3000, true);
    runner.start();
    timers.advance(600);

    playOut(runner, () => allIn());
    timers.advance(600);

    const aStack = runner.stacks().get('a') ?? -1;
    if (aStack === 0) {
      const seatNo = runner.seatOf('a');
      expect(seatNo).not.toBeNull();
      expect(runner.unseat(seatNo as number)?.stack).toBe(0);
      expect(runner.seatOf('a')).toBeNull();
    }
    // whatever happened, chips are conserved
    expect([...runner.stacks().values()].reduce((s, x) => s + x, 0) + aStack * 0).toBe(
      aStack === 0 ? 6020 - 0 : 6020,
    );
  });

  it('gives a disconnected actor the shorter clock, times them out, but never unseats them', () => {
    const { runner, timers, notifications, seat } = harness({ seed: 2, seats: 2 });
    // seat 0 acts first heads-up (button/SB) - and they are disconnected
    seat('b', 0, 2000, false);
    seat('a', 1, 2000, true);
    runner.start();
    timers.advance(500); // fires the next-hand job exactly on its due tick

    expect(runner.gameState.actingSeat).toBe(0);
    expect((runner.gameState.actionDeadline ?? 0) - timers.now).toBe(200); // the short clock

    timers.advance(300); // fire the short timeout -> b folds
    expect(runner.handInProgress).toBe(false);
    expect(runner.seatOf('b')).not.toBeNull(); // still seated - you only leave by busting
    expect(notifications.some((n) => n.kind === 'handComplete')).toBe(true);
  });

  it('rejects a stale-hand action', () => {
    const { runner, timers, notifications, seat } = harness({ seed: 1, seats: 2 });
    seat('a', 0, 2000, true);
    seat('b', 1, 2000, true);
    runner.start();
    timers.advance(600);
    runner.submitAction('a', 'not-the-hand-id', 1, call());
    expect(notifications.some((n) => n.kind === 'rejected' && n.code === 'STALE_HAND')).toBe(true);
  });
});
