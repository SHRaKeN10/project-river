/**
 * A tournament's blind structure: an ordered list of timed levels. A break is
 * just a level flagged `isBreak` (no hands start during it). The engine only
 * does the timing maths; the application owns the wall clock and pause state
 * and asks "which level are we in `elapsedMs` of running time?".
 */
export interface BlindLevel {
  /** 1-indexed, strictly sequential (level 1, 2, 3, ...). */
  readonly level: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  /** Big-blind ante posted by the player in the big blind. 0 = no ante. */
  readonly ante: number;
  readonly durationMs: number;
  /** A scheduled break - no new hands begin, blinds are unchanged for display. */
  readonly isBreak: boolean;
}

export type BlindSchedule = readonly BlindLevel[];

export function validateBlindSchedule(schedule: BlindSchedule): void {
  if (schedule.length === 0) throw new Error('a blind schedule needs at least one level');
  schedule.forEach((lvl, i) => {
    if (lvl.level !== i + 1) {
      throw new Error(`blind level ${i} is numbered ${lvl.level}, expected ${i + 1}`);
    }
    if (lvl.durationMs <= 0) throw new Error(`level ${lvl.level} has a non-positive duration`);
    if (!lvl.isBreak) {
      if (lvl.smallBlind <= 0 || lvl.bigBlind <= 0) {
        throw new Error(`level ${lvl.level} has non-positive blinds`);
      }
      if (lvl.smallBlind > lvl.bigBlind) {
        throw new Error(`level ${lvl.level} small blind exceeds big blind`);
      }
    }
    if (lvl.ante < 0) throw new Error(`level ${lvl.level} has a negative ante`);
  });
}

/** Milliseconds from tournament start at which `level` (1-indexed) begins. */
export function levelStartMs(schedule: BlindSchedule, level: number): number {
  let ms = 0;
  for (const lvl of schedule) {
    if (lvl.level === level) return ms;
    ms += lvl.durationMs;
  }
  // Past the end: the clock sits at the total, on the final level.
  return ms;
}

export function totalScheduledMs(schedule: BlindSchedule): number {
  return schedule.reduce((sum, lvl) => sum + lvl.durationMs, 0);
}

/**
 * The level in effect after `elapsedMs` of *running* (unpaused) time. Clamps to
 * the last level once the schedule is exhausted - a real tournament just keeps
 * playing the top level until it ends.
 */
export function blindLevelAt(schedule: BlindSchedule, elapsedMs: number): BlindLevel {
  if (schedule.length === 0) throw new Error('empty blind schedule');
  const clamped = Math.max(0, elapsedMs);
  let ms = 0;
  for (const lvl of schedule) {
    ms += lvl.durationMs;
    if (clamped < ms) return lvl;
  }
  return schedule[schedule.length - 1] as BlindLevel;
}

/**
 * A conventional escalating structure for seeding and tests: the big blind
 * roughly doubles every couple of levels, the small blind is half of it, a
 * big-blind ante equal to the big blind kicks in from level 3, and a break
 * lands every `breakEvery` levels.
 */
export function standardBlindSchedule(opts: {
  startingBigBlind: number;
  levelDurationMs: number;
  levels: number;
  breakEvery?: number;
  breakDurationMs?: number;
}): BlindSchedule {
  const { startingBigBlind, levelDurationMs, levels } = opts;
  const breakEvery = opts.breakEvery ?? 0;
  const breakDurationMs = opts.breakDurationMs ?? levelDurationMs;

  // bb multipliers for the first dozen levels, then keep multiplying by 1.5.
  const steps = [1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48];
  const bbFor = (i: number): number => {
    const mult = i < steps.length ? (steps[i] as number) : 48 * 1.5 ** (i - steps.length + 1);
    return Math.max(startingBigBlind, Math.round((startingBigBlind * mult) / 2) * 2);
  };

  const out: BlindLevel[] = [];
  let n = 0;
  for (let i = 0; i < levels; i += 1) {
    const bb = bbFor(i);
    out.push({
      level: (n += 1),
      smallBlind: Math.max(1, Math.round(bb / 2)),
      bigBlind: bb,
      ante: i >= 2 ? bb : 0,
      durationMs: levelDurationMs,
      isBreak: false,
    });
    if (breakEvery > 0 && (i + 1) % breakEvery === 0 && i + 1 < levels) {
      out.push({
        level: (n += 1),
        smallBlind: bb,
        bigBlind: bb,
        ante: 0,
        durationMs: breakDurationMs,
        isBreak: true,
      });
    }
  }
  return out;
}
