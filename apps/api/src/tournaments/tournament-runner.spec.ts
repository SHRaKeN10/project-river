import { Logger } from '@nestjs/common';
import {
  allIn,
  call,
  check,
  type GameState,
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

const flush = async (): Promise<void> => {
  for (let round = 0; round < 3; round += 1) {
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  }
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

async function runToCompletion(
  runner: TournamentRunner,
  timers: FakeTimers,
  pick: (s: GameState, seat: number) => PlayerAction,
): Promise<void> {
  let seq = 0;
  for (let step = 0; step < 20_000 && runner.running; step += 1) {
    const s = runner.tableState;
    const live = s && s.street !== Street.Waiting && s.street !== Street.Complete;
    if (live && s.actingSeat !== null) {
      const p = s.players.find((x) => x.seatNumber === s.actingSeat);
      if (p) runner.act(p.userId, s.handId, (seq += 1), pick(s, s.actingSeat));
    } else {
      timers.advance(600); // start the next hand / advance the clock
    }
    await flush();
  }
}

// --- tests ------------------------------------------------------------

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

describe('TournamentRunner (single table)', () => {
  it('runs a 3-handed tournament to a winner, records the finishing order, and pays the ladder', async () => {
    const row = makeRow({ entrants: 3, seatsPerTable: 3, startingStack: 800 });
    const prisma = fakePrisma(row);
    const chips = fakeChips();
    const timers = new FakeTimers();
    const runner = new TournamentRunner('tourney-1', {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chips: chips as any,
      rng: new SeededRandomProvider(11),
      timers,
      now: () => timers.now,
      actionTimeoutMs: 1_000,
      disconnectGraceMs: 200,
      nextHandDelayMs: 500,
    });

    await runner.start();
    expect(row.status).toBe('RUNNING');
    expect(row.startedAt).not.toBeNull();

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
    const chips = fakeChips();
    const timers = new FakeTimers();
    const runner = new TournamentRunner('tourney-1', {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: fakePrisma(row) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chips: chips as any,
      rng: new SeededRandomProvider(4),
      timers,
      now: () => timers.now,
      actionTimeoutMs: 1_000,
      disconnectGraceMs: 200,
      nextHandDelayMs: 500,
    });
    await runner.start();

    let seq = 0;
    for (let step = 0; step < 20_000 && runner.running; step += 1) {
      const s = runner.tableState;
      if (
        s &&
        s.street !== Street.Waiting &&
        s.street !== Street.Complete &&
        s.actingSeat !== null
      ) {
        const p = s.players.find((x) => x.seatNumber === s.actingSeat);
        if (p) runner.act(p.userId, s.handId, (seq += 1), callStation(s, s.actingSeat));
      } else {
        timers.advance(600);
      }
      await flush();
      // sum of live stacks + already-cashed (0) is always the full chip count
      const total = [...runner.stacks().values()].reduce((a, b) => a + b, 0);
      if (runner.running) expect(total).toBe(2400);
    }
    expect(row.status).toBe('FINISHED');
    expect(row.entries.filter((e) => e.finishPosition === 1)).toHaveLength(1);
  });

  it('pays two places for a nine-handed field, top-heavy and summing to the pool', async () => {
    const row = makeRow({ entrants: 9, seatsPerTable: 9, startingStack: 500 });
    const chips = fakeChips();
    const timers = new FakeTimers();
    const runner = new TournamentRunner('tourney-1', {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: fakePrisma(row) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chips: chips as any,
      rng: new SeededRandomProvider(99),
      timers,
      now: () => timers.now,
      actionTimeoutMs: 1_000,
      disconnectGraceMs: 200,
      nextHandDelayMs: 500,
    });
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

  it('refuses to start a field that does not fit one table', async () => {
    const row = makeRow({ entrants: 10, seatsPerTable: 9 });
    const timers = new FakeTimers();
    const runner = new TournamentRunner('tourney-1', {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: fakePrisma(row) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chips: fakeChips() as any,
      rng: new SeededRandomProvider(1),
      timers,
      now: () => timers.now,
      actionTimeoutMs: 1_000,
      disconnectGraceMs: 200,
      nextHandDelayMs: 500,
    });
    await expect(runner.start()).rejects.toThrow(/multi-table/);
    expect(row.status).toBe('REGISTERING');
  });
});
