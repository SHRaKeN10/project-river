import { standardBlindSchedule } from '@river/poker-engine';
import { currentLevel, elapsedRunningMs, levelEndsAt } from './tournament-clock';

const schedule = standardBlindSchedule({
  startingBigBlind: 20,
  levelDurationMs: 600_000, // 10 minutes
  levels: 6,
});

describe('elapsedRunningMs', () => {
  it('is zero before the clock starts', () => {
    expect(elapsedRunningMs({ startedAt: null, pausedMs: 0, pausedAt: null }, 1_000_000)).toBe(0);
  });

  it('is real time minus accumulated pauses', () => {
    const clock = { startedAt: 1_000, pausedMs: 120_000, pausedAt: null };
    expect(elapsedRunningMs(clock, 1_000 + 900_000)).toBe(900_000 - 120_000);
  });

  it('also subtracts the time spent in the current pause', () => {
    const clock = { startedAt: 1_000, pausedMs: 0, pausedAt: 1_000 + 300_000 };
    // 500s of wall time, paused for the last 200s -> 300s of running time
    expect(elapsedRunningMs(clock, 1_000 + 500_000)).toBe(300_000);
  });

  it('never goes negative', () => {
    const clock = { startedAt: 1_000, pausedMs: 999_999, pausedAt: null };
    expect(elapsedRunningMs(clock, 1_000 + 100_000)).toBe(0);
  });
});

describe('currentLevel / levelEndsAt', () => {
  const clock = { startedAt: 0, pausedMs: 0, pausedAt: null };

  it('tracks the schedule as running time advances', () => {
    expect(currentLevel(schedule, clock, 0).level).toBe(1);
    expect(currentLevel(schedule, clock, 599_999).level).toBe(1);
    expect(currentLevel(schedule, clock, 600_000).level).toBe(2);
    expect(currentLevel(schedule, clock, 3_600_000).level).toBe(6); // clamps to the top level
  });

  it('reports the wall-clock time the current level ends', () => {
    // 5 minutes into level 1 -> level ends 5 more minutes from now
    expect(levelEndsAt(schedule, clock, 300_000)).toBe(600_000);
    expect(levelEndsAt(schedule, clock, 700_000)).toBe(1_200_000); // in level 2
  });

  it('has no end once the final level is reached, or before the start', () => {
    expect(levelEndsAt(schedule, clock, 10_000_000)).toBeNull();
    expect(levelEndsAt(schedule, { startedAt: null, pausedMs: 0, pausedAt: null }, 0)).toBeNull();
  });

  it('a pause pushes the level-end wall time back', () => {
    const paused = { startedAt: 0, pausedMs: 0, pausedAt: 200_000 };
    // 400s of wall time, running time frozen at 200s -> level 1, ends 400s of
    // running time from the 200s mark, i.e. now + 400s
    expect(currentLevel(schedule, paused, 400_000).level).toBe(1);
    expect(levelEndsAt(schedule, paused, 400_000)).toBe(400_000 + 400_000);
  });
});
