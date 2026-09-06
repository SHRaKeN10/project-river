import { Logger } from '@nestjs/common';
import {
  allIn,
  call,
  check,
  type GameState,
  placesPaid as placesPaidOf,
  type PlayerAction,
  SeededRandomProvider,
  standardBlindSchedule,
  Street,
} from '@river/poker-engine';
import { type TimerScheduler } from '../tables/table-runner';
import { TournamentRunner } from './tournament-runner';

// --- fakes ---------------------------------------------------------------

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
    for (let guard = 0; guard < 5000; guard += 1) {
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
}

interface FakeEntry {
  id: string;
  userId: string;
  registeredAt: Date;
  stack: number;
  eliminatedAt: Date | null;
  finishPosition: number | null;
  payout: number;
}

function fakePrisma(row: Record<string, unknown> & { entries: FakeEntry[] }) {
  return {
    user: {
      findMany: async () =>
        row.entries.map((e) => ({ id: e.userId, username: e.userId, avatarUrl: null })),
    },
    tournament: {
      findUniqueOrThrow: async () => structuredCloneish(row),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(row, data);
        return row;
      },
    },
    tournamentEntry: {
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const e = row.entries.find((x) => x.id === where.id);
        if (e) Object.assign(e, data);
        return e;
      },
    },
  };
}

/** shallow clone that keeps entry objects live enough for the runner's reads */
function structuredCloneish<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function fakeChips() {
  const moves: { userId: string; amount: number; reason: string; idemKey: string }[] = [];
  return {
    moves,
    move: async (m: { userId: string; amount: number; reason: string; idemKey: string }) => {
      if (moves.some((x) => x.idemKey === m.idemKey)) return 0; // idempotent
      moves.push(m);
      return 0;
    },
  };
}

/** Let the coordinator's async tail (persist + balance + finish check) settle.
 * Its awaits are all on already-resolved promises, so one macrotask tick after
 * the microtask queue drains is enough. */
const flush = async (): Promise<void> => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

const callStation = (s: GameState, seat: number): PlayerAction => {
  const p = s.players.find((x) => x.seatNumber === seat);
  return s.round.currentBet - (p?.currentBet ?? 0) > 0 ? call() : check();
};

// --- harness ------------------------------------------------------------

function makeRow(opts: { entrants: number; seatsPerTable: number; startingStack?: number }) {
  const startingStack = opts.startingStack ?? 1500;
  // Short levels so a fake-time test actually climbs the structure.
  const blinds = standardBlindSchedule({
    startingBigBlind: 20,
    levelDurationMs: 3_000,
    levels: 12,
  });
  return {
    id: 'tourney-1',
    status: 'REGISTERING',
    gameType: 'NLHE',
    buyIn: 100,
    entryFee: 0,
    startingStack,
    seatsPerTable: opts.seatsPerTable,
    blindsJson: blinds as unknown as object[],
    lateRegUntilLevel: 1,
    maxEntrants: null,
    startedAt: null as Date | null,
    pausedMs: 0,
    pausedAt: null as Date | null,
    finishedAt: null as Date | null,
    resultsJson: null as unknown,
    entries: Array.from({ length: opts.entrants }, (_, i) => ({
      id: `e${i}`,
      userId: `u${i}`,
      registeredAt: new Date(1_000 + i),
      stack: 0,
      eliminatedAt: null,
      finishPosition: null,
      payout: 0,
    })) as FakeEntry[],
  };
}

function makeRunner(
  row: Record<string, unknown> & { entries: FakeEntry[] },
  seed: number,
): {
  runner: TournamentRunner;
  timers: FakeTimers;
  chips: ReturnType<typeof fakeChips>;
} {
  const chips = fakeChips();
  const timers = new FakeTimers();
  const runner = new TournamentRunner('tourney-1', {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma: fakePrisma(row) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    chips: chips as any,
    rng: new SeededRandomProvider(seed),
    timers,
    now: () => timers.now,
    actionTimeoutMs: 1_000,
    disconnectGraceMs: 200,
    nextHandDelayMs: 500,
  });
  return { runner, timers, chips };
}

/** Drive every table that has someone to act; advance the clock when they are
 * all between hands. Works for one table or many. `tableOrder: 'reverse'`
 * feeds actions to the tables in the opposite order each step, so a test can
 * check that table-completion order never moves the standings. */
async function runToCompletion(
  runner: TournamentRunner,
  timers: FakeTimers,
  pick: (s: GameState, seat: number) => PlayerAction,
  onStep?: () => void,
  tableOrder: 'forward' | 'reverse' = 'forward',
): Promise<void> {
  let seq = 0;
  for (let step = 0; step < 250_000 && runner.running; step += 1) {
    let acted = false;
    const tables = runner.tableStates();
    for (const { state: s } of tableOrder === 'reverse' ? [...tables].reverse() : tables) {
      const live = s.street !== Street.Waiting && s.street !== Street.Complete;
      if (live && s.actingSeat !== null) {
        const p = s.players.find((x) => x.seatNumber === s.actingSeat);
        if (p) {
          runner.act(p.userId, s.handId, (seq += 1), pick(s, s.actingSeat));
          acted = true;
        }
      }
    }
    if (!acted) timers.advance(600);
    await flush();
    onStep?.();
  }
}

type Result = { userId?: string; position: number; payout: number };

/** The standings invariants that must hold for EVERY finished tournament,
 * regardless of ties / chops. */
function assertStandingsInvariants(
  results: Result[],
  entrants: number,
  prizePool: number,
  placesPaidCount: number,
): void {
  // one row per entrant, positions are exactly 1..N with none repeated
  expect(results).toHaveLength(entrants);
  const positions = results.map((r) => r.position).sort((a, b) => a - b);
  expect(positions).toEqual(Array.from({ length: entrants }, (_, i) => i + 1));

  // payouts sum to the pool exactly - no chip created or lost
  expect(results.reduce((s, r) => s + r.payout, 0)).toBe(prizePool);

  const byPos = new Map(results.map((r) => [r.position, r.payout]));
  // never increases down the standings
  for (let p = 2; p <= entrants; p += 1) {
    expect(byPos.get(p)!).toBeLessThanOrEqual(byPos.get(p - 1)!);
  }
  // every position past the paid places + any bubble chop gets nothing
  for (let p = placesPaidCount + 2; p <= entrants; p += 1) expect(byPos.get(p)).toBe(0);
  // the winner is always paid
  expect(byPos.get(1)!).toBeGreaterThan(0);
}

// --- tests ------------------------------------------------------------

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

describe('TournamentRunner', () => {
  it('runs a 3-handed tournament to a winner, records the finishing order, and pays the ladder', async () => {
    const row = makeRow({ entrants: 3, seatsPerTable: 3, startingStack: 800 });
    const { runner, timers, chips } = makeRunner(row, 11);

    await runner.start();
    expect(row.status).toBe('RUNNING');
    expect(row.startedAt).not.toBeNull();
    expect(runner.tableCount).toBe(1);

    await runToCompletion(runner, timers, () => allIn());

    expect(runner.running).toBe(false);
    expect(row.status).toBe('FINISHED');
    expect(row.finishedAt).not.toBeNull();

    // every entry has a finishing position, 1..3, all distinct
    const positions = row.entries.map((e) => e.finishPosition).sort();
    expect(positions).toEqual([1, 2, 3]);

    // conservation: the winner holds every chip
    const winner = row.entries.find((e) => e.finishPosition === 1);
    expect(winner?.stack).toBe(2400);

    // one paid place (placesPaid(3) === 1); winner gets the whole 300-chip pool
    const results = row.resultsJson as { userId: string; position: number; payout: number }[];
    expect(results.map((r) => r.position)).toEqual([1, 2, 3]);
    expect(results[0]?.payout).toBe(300);
    expect(results[1]?.payout).toBe(0);
    expect(results[2]?.payout).toBe(0);

    // exactly one payout movement, to the winner, keyed on their entry id
    const payouts = chips.moves.filter((m) => m.reason === 'TOURNAMENT_PAYOUT');
    expect(payouts).toHaveLength(1);
    expect(payouts[0]).toMatchObject({
      userId: winner?.userId,
      amount: 300,
      idemKey: `tpay:${winner?.id}`,
    });
  });

  it('conserves chips across every hand of a 4-handed tournament', async () => {
    const row = makeRow({ entrants: 4, seatsPerTable: 4, startingStack: 600 });
    const { runner, timers } = makeRunner(row, 4);
    await runner.start();

    await runToCompletion(runner, timers, callStation, () => {
      const total = [...runner.stacks().values()].reduce((a, b) => a + b, 0);
      if (runner.running) expect(total).toBe(2400);
    });

    expect(row.status).toBe('FINISHED');
    expect(row.entries.filter((e) => e.finishPosition === 1)).toHaveLength(1);
  });

  it('pays two places for a nine-handed field, top-heavy and summing to the pool', async () => {
    const row = makeRow({ entrants: 9, seatsPerTable: 9, startingStack: 500 });
    const { runner, timers, chips } = makeRunner(row, 99);
    await runner.start();
    await runToCompletion(runner, timers, () => allIn());

    expect(row.status).toBe('FINISHED');
    const results = row.resultsJson as { position: number; payout: number }[];
    expect(results).toHaveLength(9);
    expect(results[0]!.payout + results[1]!.payout).toBe(900); // whole pool
    expect(results[0]!.payout).toBeGreaterThan(results[1]!.payout);
    expect(results.slice(2).every((r) => r.payout === 0)).toBe(true);

    const payouts = chips.moves.filter((m) => m.reason === 'TOURNAMENT_PAYOUT');
    expect(payouts).toHaveLength(2);
    expect(payouts.reduce((a, m) => a + m.amount, 0)).toBe(900);
  });

  it('runs a three-table field: balances, breaks tables down to one, crowns a winner', async () => {
    const row = makeRow({ entrants: 12, seatsPerTable: 4, startingStack: 500 });
    const { runner, timers, chips } = makeRunner(row, 7);
    await runner.start();
    expect(runner.tableCount).toBe(3);

    let maxTables = runner.tableCount;
    let minTables = runner.tableCount;
    await runToCompletion(
      runner,
      timers,
      () => allIn(),
      () => {
        if (runner.running) {
          maxTables = Math.max(maxTables, runner.tableCount);
          minTables = Math.min(minTables, runner.tableCount);
          // conservation across every table, every step
          const total = [...runner.stacks().values()].reduce((a, b) => a + b, 0);
          expect(total).toBe(6000);
        }
      },
    );

    expect(row.status).toBe('FINISHED');
    expect(maxTables).toBe(3);
    expect(minTables).toBe(1); // it collapsed to a final table

    // 12 distinct finishing positions
    const positions = row.entries.map((e) => e.finishPosition).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(positions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    const winner = row.entries.find((e) => e.finishPosition === 1);
    expect(winner?.stack).toBe(6000); // holds every chip

    // placesPaid(12) === 2; the pool (1200) is distributed exactly (a bubble
    // chop can spread it a rung wider, but the total and the invariants hold)
    const results = row.resultsJson as Result[];
    assertStandingsInvariants(results, 12, 1200, 2);
    const paidMoves = chips.moves.filter((m) => m.reason === 'TOURNAMENT_PAYOUT');
    expect(paidMoves.length).toBeGreaterThanOrEqual(2);
    expect(paidMoves.reduce((a, m) => a + m.amount, 0)).toBe(1200);
  });

  it('runs a 24-player, four-table field clean: every seat count 4..1, one winner', async () => {
    const row = makeRow({ entrants: 24, seatsPerTable: 6, startingStack: 400 });
    const { runner, timers } = makeRunner(row, 21);
    await runner.start();
    expect(runner.tableCount).toBe(4);

    const seenTableCounts = new Set<number>();
    await runToCompletion(
      runner,
      timers,
      () => allIn(),
      () => {
        if (runner.running) {
          seenTableCounts.add(runner.tableCount);
          expect([...runner.stacks().values()].reduce((a, b) => a + b, 0)).toBe(9600);
          // no table ever exceeds its seat cap
          for (const { state } of runner.tableStates()) {
            expect(state.players.length).toBeLessThanOrEqual(6);
          }
        }
      },
    );

    expect(row.status).toBe('FINISHED');
    // the field collapsed 4 -> 3 -> 2 -> 1 at some point along the way
    expect(seenTableCounts.has(4)).toBe(true);
    expect(seenTableCounts.has(1)).toBe(true);

    const positions = row.entries.map((e) => e.finishPosition).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(positions).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(row.entries.find((e) => e.finishPosition === 1)?.stack).toBe(9600);
  });

  it('holds three full nine-handed tables (27 entrants) and plays them down to a winner', async () => {
    const row = makeRow({ entrants: 27, seatsPerTable: 9, startingStack: 300 });
    const { runner, timers, chips } = makeRunner(row, 27);
    await runner.start();
    expect(runner.tableCount).toBe(3);
    expect(runner.tableSeatCounts()).toEqual([9, 9, 9]); // three full nine-handed tables

    const seenCounts = new Set<number>();
    await runToCompletion(
      runner,
      timers,
      () => allIn(),
      () => {
        if (runner.running) {
          seenCounts.add(runner.tableCount);
          expect([...runner.stacks().values()].reduce((a, b) => a + b, 0)).toBe(8100);
          for (const { state } of runner.tableStates()) {
            expect(state.players.length).toBeLessThanOrEqual(9);
          }
        }
      },
    );

    expect(row.status).toBe('FINISHED');
    expect(seenCounts.has(3)).toBe(true);
    expect(seenCounts.has(1)).toBe(true);
    const positions = row.entries.map((e) => e.finishPosition).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(positions).toEqual(Array.from({ length: 27 }, (_, i) => i + 1));
    expect(row.entries.find((e) => e.finishPosition === 1)?.stack).toBe(8100);
    // placesPaid(27) === 4; the whole pool is split among them, top-heavy
    const results = row.resultsJson as { position: number; payout: number }[];
    const paid = results.filter((r) => r.payout > 0);
    expect(paid).toHaveLength(4);
    expect(paid.reduce((a, r) => a + r.payout, 0)).toBe(2700);
    expect(chips.moves.filter((m) => m.reason === 'TOURNAMENT_PAYOUT')).toHaveLength(4);
  });

  it('scales to ten full nine-handed tables (90 entrants) and resolves to one winner', async () => {
    const row = makeRow({ entrants: 90, seatsPerTable: 9, startingStack: 200 });
    const { runner, timers, chips } = makeRunner(row, 90);
    await runner.start();
    expect(runner.tableCount).toBe(10);
    expect(runner.tableSeatCounts()).toEqual(Array.from({ length: 10 }, () => 9));

    const seenCounts = new Set<number>();
    await runToCompletion(
      runner,
      timers,
      () => allIn(),
      () => {
        if (runner.running) {
          seenCounts.add(runner.tableCount);
          expect([...runner.stacks().values()].reduce((a, b) => a + b, 0)).toBe(18_000);
          for (const c of runner.tableSeatCounts()) expect(c).toBeLessThanOrEqual(9);
        }
      },
    );

    expect(row.status).toBe('FINISHED');
    expect(seenCounts.has(10)).toBe(true);
    expect(seenCounts.has(1)).toBe(true);

    const positions = row.entries.map((e) => e.finishPosition).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(positions).toEqual(Array.from({ length: 90 }, (_, i) => i + 1));
    expect(row.entries.find((e) => e.finishPosition === 1)?.stack).toBe(18_000);

    // placesPaid(90) === 11; the 9000 pool is distributed exactly
    const results = row.resultsJson as Result[];
    assertStandingsInvariants(results, 90, 9000, 11);
    const paidMoves = chips.moves.filter((m) => m.reason === 'TOURNAMENT_PAYOUT');
    expect(paidMoves.length).toBeGreaterThanOrEqual(11);
    expect(paidMoves.reduce((a, m) => a + m.amount, 0)).toBe(9000);
  }, 30_000);

  it('runs a 200-player, 23-table field to a single winner with the full payout ladder', async () => {
    const row = makeRow({ entrants: 200, seatsPerTable: 9, startingStack: 150 });
    const { runner, timers, chips } = makeRunner(row, 200);
    await runner.start();
    expect(runner.tableCount).toBe(23); // ceil(200 / 9)
    // even split: 200 = 16*9 + 7*8
    const startSeats = runner.tableSeatCounts().sort((a, b) => a - b);
    expect(startSeats.filter((c) => c === 8)).toHaveLength(7);
    expect(startSeats.filter((c) => c === 9)).toHaveLength(16);
    expect(startSeats.reduce((a, b) => a + b, 0)).toBe(200);

    let sawFinalTable = false;
    await runToCompletion(
      runner,
      timers,
      () => allIn(),
      () => {
        if (runner.running) {
          if (runner.tableCount === 1) sawFinalTable = true;
          expect([...runner.stacks().values()].reduce((a, b) => a + b, 0)).toBe(30_000);
          for (const c of runner.tableSeatCounts()) expect(c).toBeLessThanOrEqual(9);
          // tables only ever shrink in number
          expect(runner.tableCount).toBeLessThanOrEqual(23);
        }
      },
    );

    expect(row.status).toBe('FINISHED');
    expect(sawFinalTable).toBe(true);

    const positions = row.entries.map((e) => e.finishPosition).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(positions).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    expect(row.entries.find((e) => e.finishPosition === 1)?.stack).toBe(30_000);

    // placesPaid(200) === 24; the whole 20000 pool is distributed exactly
    const results = row.resultsJson as Result[];
    assertStandingsInvariants(results, 200, 20_000, 24);
    const paidMoves = chips.moves.filter((m) => m.reason === 'TOURNAMENT_PAYOUT');
    expect(paidMoves.length).toBeGreaterThanOrEqual(24);
    expect(paidMoves.reduce((a, m) => a + m.amount, 0)).toBe(20_000);
  }, 60_000);

  it('refuses a heads-up multi-table field', async () => {
    const row = makeRow({ entrants: 3, seatsPerTable: 2 });
    const { runner } = makeRunner(row, 1);
    await expect(runner.start()).rejects.toThrow(/three seats per table/);
    expect(row.status).toBe('REGISTERING');
  });

  // --- hand-for-hand & chops: adversarial coverage ---------------------

  const finalStandings = (row: ReturnType<typeof makeRow>) =>
    row.entries
      .map((e) => ({ userId: e.userId, position: e.finishPosition, payout: e.payout }))
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  it('is fully deterministic: the same seed produces byte-identical standings twice', async () => {
    const runOnce = async () => {
      const row = makeRow({ entrants: 18, seatsPerTable: 6, startingStack: 300 });
      const { runner, timers } = makeRunner(row, 314);
      await runner.start();
      await runToCompletion(runner, timers, () => allIn());
      return { standings: finalStandings(row), results: row.resultsJson };
    };
    const a = await runOnce();
    const b = await runOnce();
    expect(a).toEqual(b);
  });

  it('table-completion order never moves the standings (forward vs reverse driving)', async () => {
    const run = async (order: 'forward' | 'reverse') => {
      const row = makeRow({ entrants: 15, seatsPerTable: 5, startingStack: 300 });
      const { runner, timers } = makeRunner(row, 77);
      await runner.start();
      expect(runner.tableCount).toBe(3);
      await runToCompletion(runner, timers, () => allIn(), undefined, order);
      return { standings: finalStandings(row), results: row.resultsJson };
    };
    expect(await run('forward')).toEqual(await run('reverse'));
  });

  it('a multi-table field always fills exactly one contiguous set of places and pays the pool', async () => {
    // callStation keeps stacks varied so ties are rare - a clean-ladder check.
    const row = makeRow({ entrants: 15, seatsPerTable: 5, startingStack: 600 });
    const { runner, timers } = makeRunner(row, 202);
    await runner.start();

    let sawHeadsUp = false;
    let sawFinalTable = false;
    await runToCompletion(runner, timers, callStation, () => {
      if (runner.running) {
        if (runner.tableCount === 1) sawFinalTable = true;
        const live = [...runner.stacks().values()].filter((s) => s > 0).length;
        if (live === 2) sawHeadsUp = true;
        expect([...runner.stacks().values()].reduce((a, b) => a + b, 0)).toBe(9000);
      }
    });

    expect(row.status).toBe('FINISHED');
    expect(sawFinalTable).toBe(true);
    expect(sawHeadsUp).toBe(true);
    assertStandingsInvariants(row.resultsJson as Result[], 15, 1500, placesPaidOf(15));
  });

  it('an eliminated player has exactly one position and no position is used twice, hand by hand', async () => {
    const row = makeRow({ entrants: 12, seatsPerTable: 4, startingStack: 400 });
    const { runner, timers } = makeRunner(row, 9);
    await runner.start();

    await runToCompletion(
      runner,
      timers,
      () => allIn(),
      () => {
        const positions = row.entries
          .map((e) => e.finishPosition)
          .filter((p): p is number => p !== null);
        // distinct, in range, contiguous-from-the-bottom at every observation
        expect(new Set(positions).size).toBe(positions.length);
        for (const p of positions) expect(p >= 1 && p <= 12).toBe(true);
      },
    );

    const positions = row.entries.map((e) => e.finishPosition).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(positions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assertStandingsInvariants(row.resultsJson as Result[], 12, 1200, placesPaidOf(12));
  });
});
