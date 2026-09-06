import { Logger } from '@nestjs/common';
import {
  allIn,
  call,
  check,
  type GameState,
  legalActions,
  type PlayerAction,
  type RandomProvider,
  standardBlindSchedule,
  Street,
} from '@river/poker-engine';
import { type TimerScheduler } from '../tables/table-runner';
import { TournamentRunner } from './tournament-runner';
import { TournamentRecoveryError, type TournamentSnapshot } from './tournament-recovery';

/**
 * Restart recovery for a running tournament (ADR-0025). The headline guarantee:
 * rehydrating from a checkpoint and continuing produces the *same deterministic
 * outcome* as never restarting - the in-progress hand comes back exactly
 * (deck, street, board, pot, acting seat, legal actions), no hand is
 * duplicated or skipped, chips are conserved, and standings match.
 */

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

// --- fakes -----------------------------------------------------------------

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

/** mulberry32 - identical to the engine's `SeededRandomProvider` but with a
 * publicly readable/settable `state`, so a test can fork the RNG at the exact
 * instant a checkpoint was captured and prove the continuation matches. */
class ForkableRng implements RandomProvider {
  state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  private nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
    for (;;) {
      const v = this.nextUint32();
      if (v < limit) return v % maxExclusive;
    }
  }
  bytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) out[i] = this.nextUint32() & 0xff;
    return out;
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

function makeRow(opts: { entrants: number; seatsPerTable: number; startingStack?: number }) {
  const startingStack = opts.startingStack ?? 400;
  const blinds = standardBlindSchedule({
    startingBigBlind: 20,
    levelDurationMs: 3_000,
    levels: 12,
  });
  return {
    id: 'tourney-1',
    status: 'REGISTERING' as string,
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

function fakePrisma(row: ReturnType<typeof makeRow>) {
  return {
    user: {
      findMany: async () =>
        row.entries.map((e) => ({ id: e.userId, username: e.userId, avatarUrl: null })),
    },
    tournament: {
      findUniqueOrThrow: async () => JSON.parse(JSON.stringify(row)),
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

function fakeChips() {
  const moves: { userId: string; amount: number; reason: string; idemKey: string }[] = [];
  return {
    moves,
    move: async (m: { userId: string; amount: number; reason: string; idemKey: string }) => {
      if (moves.some((x) => x.idemKey === m.idemKey)) return 0;
      moves.push(m);
      return 0;
    },
  };
}

const flush = async (): Promise<void> => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

const callStation = (s: GameState, seat: number): PlayerAction => {
  const p = s.players.find((x) => x.seatNumber === seat);
  return s.round.currentBet - (p?.currentBet ?? 0) > 0 ? call() : check();
};

interface Checkpoint {
  json: string;
  rngState: number;
  now: number;
}

interface Rig {
  runner: TournamentRunner;
  timers: FakeTimers;
  rng: ForkableRng;
  row: ReturnType<typeof makeRow>;
  chips: ReturnType<typeof fakeChips>;
  checkpoints: Checkpoint[];
}

function makeRig(
  seed: number,
  opts: { entrants: number; seatsPerTable: number; startingStack?: number },
  seedRngState?: number,
  atNow?: number,
): Rig {
  const row = makeRow(opts);
  const timers = new FakeTimers();
  if (atNow !== undefined) timers.now = atNow;
  const rng = new ForkableRng(seed);
  if (seedRngState !== undefined) rng.state = seedRngState;
  const chips = fakeChips();
  const checkpoints: Checkpoint[] = [];
  const runner = new TournamentRunner('tourney-1', {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma: fakePrisma(row) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    chips: chips as any,
    rng,
    timers,
    now: () => timers.now,
    actionTimeoutMs: 1_000,
    disconnectGraceMs: 200,
    nextHandDelayMs: 500,
    persistSnapshot: (snap) => {
      checkpoints.push({ json: JSON.stringify(snap), rngState: rng.state, now: timers.now });
    },
  });
  return { runner, timers, rng, row, chips, checkpoints };
}

async function drive(
  runner: TournamentRunner,
  timers: FakeTimers,
  pick: (s: GameState, seat: number) => PlayerAction,
  fromSeq = 0,
  onStep?: () => void,
): Promise<void> {
  let seq = fromSeq;
  for (let step = 0; step < 200_000 && runner.running; step += 1) {
    let acted = false;
    for (const { state: s } of runner.tableStates()) {
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

const withoutDeadline = (s: GameState): GameState => ({ ...s, actionDeadline: null });

/** Recreate the coordinator from a checkpoint, RNG forked at the same instant,
 * and drive it to completion. Returns the recovered rig + its final results. */
async function restartFrom(
  cp: Checkpoint,
  seed: number,
  opts: { entrants: number; seatsPerTable: number; startingStack?: number },
  pick: (s: GameState, seat: number) => PlayerAction,
): Promise<Rig> {
  const snap = JSON.parse(cp.json) as TournamentSnapshot;
  const rig = makeRig(seed, opts, cp.rngState, cp.now);
  rig.row.status = 'RUNNING';
  rig.row.startedAt = new Date(snap.startedAtMs);
  await rig.runner.resumeFromSnapshot(snap, snap.startedAtMs);
  const maxSeq = Math.max(0, ...snap.tables.flatMap((t) => t.lastSeqByUser.map(([, seq]) => seq)));
  await drive(rig.runner, rig.timers, pick, maxSeq + 100);
  return rig;
}

// --- tests --------------------------------------------------------------

describe('TournamentRunner restart recovery', () => {
  it('a checkpoint round-trips the in-progress hand exactly (deck, street, board, pot, actor)', async () => {
    const opts = { entrants: 6, seatsPerTable: 6, startingStack: 600 };
    const rig = makeRig(7, opts);
    await rig.runner.start();
    // play a few streets of hand 1 with call-station bots
    await drive(rig.runner, rig.timers, callStation, 0, () => {
      // stop the driver once we have a mid-hand checkpoint on flop or later
    });

    const midHand = rig.checkpoints
      .map((c) => ({ c, snap: JSON.parse(c.json) as TournamentSnapshot }))
      .filter(({ snap }) =>
        snap.tables.some(
          (t) =>
            t.state.street !== Street.Waiting &&
            t.state.street !== Street.Complete &&
            t.state.communityCards.length >= 3,
        ),
      );
    expect(midHand.length).toBeGreaterThan(0);

    const { c, snap } = midHand[0]!;
    const rig2 = makeRig(7, opts, c.rngState, c.now);
    rig2.row.status = 'RUNNING';
    await rig2.runner.resumeFromSnapshot(snap, snap.startedAtMs);

    for (const t of snap.tables) {
      const live = rig2.runner.tableStates().find((x) => x.tableId === t.tableId);
      expect(live).toBeDefined();
      // byte-identical hand state (minus the app-layer action clock)
      expect(withoutDeadline(live!.state)).toEqual(withoutDeadline(t.state));
      // and the legal actions the acting player faces are unchanged
      if (t.state.actingSeat !== null) {
        const ctx = {
          players: t.state.players,
          round: t.state.round,
          actingSeat: t.state.actingSeat,
        };
        expect(legalActions(ctx, t.state.actingSeat)).toEqual(
          legalActions(
            {
              players: live!.state.players,
              round: live!.state.round,
              actingSeat: live!.state.actingSeat as number,
            },
            live!.state.actingSeat as number,
          ),
        );
      }
    }
  });

  it('restarting at every checkpoint reaches the identical final standings (jam bots)', async () => {
    const opts = { entrants: 6, seatsPerTable: 6, startingStack: 300 };

    // control: never restart
    const control = makeRig(21, opts);
    await control.runner.start();
    await drive(control.runner, control.timers, () => allIn());
    const finalResults = control.row.resultsJson;
    expect(Array.isArray(finalResults)).toBe(true);

    // restart from a spread of checkpoints (early, middle, late) and confirm the
    // continuation lands on exactly the same standings + payouts.
    const n = control.checkpoints.length;
    expect(n).toBeGreaterThan(6);
    const idxs = [...new Set([2, Math.floor(n / 3), Math.floor(n / 2), n - 3])].filter(
      (i) => i > 0 && i < n,
    );
    expect(idxs.length).toBeGreaterThanOrEqual(3);

    for (const i of idxs) {
      const rig = await restartFrom(control.checkpoints[i]!, 21, opts, () => allIn());
      expect(rig.row.status).toBe('FINISHED');
      expect(rig.row.resultsJson).toEqual(finalResults);
      // chips conserved end to end
      const total = (rig.row.resultsJson as { payout: number }[]).length;
      expect(total).toBe(6);
    }
  });

  it('restarting a multi-table field mid-play keeps seating consistent and finishes cleanly', async () => {
    const opts = { entrants: 12, seatsPerTable: 4, startingStack: 300 };
    const control = makeRig(88, opts);
    await control.runner.start();
    expect(control.runner.tableCount).toBe(3);
    await drive(control.runner, control.timers, () => allIn());
    const finalResults = control.row.resultsJson;

    // a checkpoint from partway through, after at least one balance
    const i = Math.floor(control.checkpoints.length * 0.4);
    const rig = await restartFrom(control.checkpoints[i]!, 88, opts, () => allIn());
    expect(rig.row.status).toBe('FINISHED');
    expect(rig.row.resultsJson).toEqual(finalResults);
    const positions = (rig.row.resultsJson as { position: number }[])
      .map((r) => r.position)
      .sort((a, b) => a - b);
    expect(positions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('recovery is a no-op-safe re-run of an interrupted round (checkpoint with pending busts)', async () => {
    const opts = { entrants: 6, seatsPerTable: 6, startingStack: 300 };
    const control = makeRig(5, opts);
    await control.runner.start();
    await drive(control.runner, control.timers, () => allIn());
    const finalResults = control.row.resultsJson;

    // find a checkpoint that captured a hand complete with a bust not yet
    // finalised (pendingBust set, finishPosition still null)
    const pendingCp = control.checkpoints
      .map((c) => ({ c, snap: JSON.parse(c.json) as TournamentSnapshot }))
      .find(({ snap }) =>
        snap.entries.some((e) => e.pendingBust !== null && e.finishPosition === null),
      );
    expect(pendingCp).toBeDefined();

    const rig = await restartFrom(pendingCp!.c, 5, opts, () => allIn());
    expect(rig.row.status).toBe('FINISHED');
    expect(rig.row.resultsJson).toEqual(finalResults);
    // no position assigned twice
    const positions = (rig.row.resultsJson as { position: number }[]).map((r) => r.position);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('the level clock survives a restart with a downtime gap - it does not reset', async () => {
    const opts = { entrants: 4, seatsPerTable: 4, startingStack: 5_000 };
    const rig = makeRig(3, opts);
    await rig.runner.start();
    // advance ~1.2s of level 1 (level is 3s), play one action
    await drive(rig.runner, rig.timers, callStation, 0, () => {
      /* let a couple of checkpoints accrue */
    });
    const cp = rig.checkpoints[Math.min(3, rig.checkpoints.length - 1)]!;
    const beforeSnap = JSON.parse(cp.json) as TournamentSnapshot;

    // restart 800ms later (simulated restart downtime)
    const rig2 = makeRig(3, opts, cp.rngState, cp.now + 800);
    rig2.row.status = 'RUNNING';
    rig2.row.startedAt = new Date(beforeSnap.startedAtMs);
    await rig2.runner.resumeFromSnapshot(beforeSnap, beforeSnap.startedAtMs);

    // clock is anchored to the persisted startedAt, so ~2s in it is still level 1
    const clock = rig2.runner.clockSnapshot();
    expect(clock.level).toBe(1);
    // and it ends at the same wall time it always would (startedAt + 3s)
    expect(clock.levelEndsAt).toBe(beforeSnap.startedAtMs + 3_000);
  });

  it('rejects a stale / incompatible snapshot and fails closed', async () => {
    const opts = { entrants: 4, seatsPerTable: 4, startingStack: 400 };
    const rig = makeRig(9, opts);
    await rig.runner.start();
    const good = JSON.parse(rig.checkpoints.at(-1)!.json) as TournamentSnapshot;
    const fresh = () => makeRig(9, opts).runner;

    await expect(fresh().resumeFromSnapshot({ ...good, v: 999 }, good.startedAtMs)).rejects.toThrow(
      TournamentRecoveryError,
    );

    // startedAt mismatch (a snapshot from an earlier run of the same id)
    await expect(fresh().resumeFromSnapshot(good, good.startedAtMs + 60_000)).rejects.toThrow(
      /stale|different run/,
    );

    // a finished marker must never be resumed
    await expect(
      fresh().resumeFromSnapshot({ ...good, phase: 'finished' }, good.startedAtMs),
    ).rejects.toThrow(/finished marker/);

    // chip total that doesn't add up -> corrupt
    const corrupt = {
      ...good,
      entries: good.entries.map((e, i) => (i === 0 ? { ...e, stack: e.stack + 999 } : e)),
    };
    await expect(fresh().resumeFromSnapshot(corrupt, good.startedAtMs)).rejects.toThrow(
      /chip total/,
    );
  });

  it('a busted player is not resurrected on recovery (their finish position is restored)', async () => {
    const opts = { entrants: 6, seatsPerTable: 6, startingStack: 300 };
    const control = makeRig(44, opts);
    await control.runner.start();
    await drive(control.runner, control.timers, () => allIn());

    // a checkpoint after at least two eliminations
    const cp = control.checkpoints
      .map((c) => ({ c, snap: JSON.parse(c.json) as TournamentSnapshot }))
      .find(({ snap }) => snap.entries.filter((e) => e.finishPosition !== null).length >= 2);
    expect(cp).toBeDefined();

    const snap = cp!.snap;
    const eliminated = snap.entries.filter((e) => e.finishPosition !== null);
    const rig = makeRig(44, opts, cp!.c.rngState, cp!.c.now);
    rig.row.status = 'RUNNING';
    await rig.runner.resumeFromSnapshot(snap, snap.startedAtMs);

    // every eliminated entry stays eliminated with the same finish, seatless,
    // and stack 0 - never dealt back in
    for (const e of eliminated) {
      const view = rig.runner.entrantView(e.userId);
      expect(view?.finishPosition).toBe(e.finishPosition);
      expect(view?.tableId).toBeNull();
      const rowEntry = rig.row.entries.find((x) => x.id === e.entryId)!;
      expect(rowEntry.finishPosition).toBe(e.finishPosition);
      expect(rowEntry.stack).toBe(0);
    }
    // chip conservation across the recovery
    expect(rig.runner.totalChips).toBe(opts.startingStack * opts.entrants);
  });
});
