import {
  type BlindLevel,
  type BlindSchedule,
  blindLevelAt,
  levelStartMs,
} from '@river/poker-engine';

/**
 * The persisted level-clock bookmark. Real elapsed time minus the time the
 * tournament has spent paused gives the "running" time the blind schedule is
 * measured against.
 */
export interface ClockState {
  /** Epoch millis the clock started; null before the tournament is RUNNING. */
  startedAt: number | null;
  /** Total millis the clock has been paused. */
  pausedMs: number;
  /** Epoch millis the current pause began; null unless PAUSED. */
  pausedAt: number | null;
}

/** Millis of *running* (unpaused) time since the clock started. */
export function elapsedRunningMs(clock: ClockState, now: number): number {
  if (clock.startedAt === null) return 0;
  const pausedNow = clock.pausedAt === null ? 0 : Math.max(0, now - clock.pausedAt);
  return Math.max(0, now - clock.startedAt - clock.pausedMs - pausedNow);
}

/** The blind level in effect right now. */
export function currentLevel(schedule: BlindSchedule, clock: ClockState, now: number): BlindLevel {
  return blindLevelAt(schedule, elapsedRunningMs(clock, now));
}

/** Epoch millis at which the current level ends (when the next begins), or null
 * once the schedule is exhausted / not yet started. */
export function levelEndsAt(
  schedule: BlindSchedule,
  clock: ClockState,
  now: number,
): number | null {
  if (clock.startedAt === null) return null;
  const level = currentLevel(schedule, clock, now).level;
  if (level >= schedule.length) return null; // final level runs until the tournament ends
  const nextStart = levelStartMs(schedule, level + 1);
  // convert running-time offset back to wall time
  return now + (nextStart - elapsedRunningMs(clock, now));
}
