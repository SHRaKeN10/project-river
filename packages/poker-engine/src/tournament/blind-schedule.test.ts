import {
  type BlindLevel,
  blindLevelAt,
  levelStartMs,
  standardBlindSchedule,
  totalScheduledMs,
  validateBlindSchedule,
} from './blind-schedule';

const lvl = (over: Partial<BlindLevel> & { level: number }): BlindLevel => ({
  smallBlind: over.level * 10,
  bigBlind: over.level * 20,
  ante: 0,
  durationMs: 60_000,
  isBreak: false,
  ...over,
});

const schedule = [lvl({ level: 1 }), lvl({ level: 2 }), lvl({ level: 3 })];

describe('validateBlindSchedule', () => {
  it('accepts a well-formed schedule', () => {
    expect(() => validateBlindSchedule(schedule)).not.toThrow();
    expect(() =>
      validateBlindSchedule(
        standardBlindSchedule({
          startingBigBlind: 20,
          levelDurationMs: 600_000,
          levels: 20,
          breakEvery: 4,
        }),
      ),
    ).not.toThrow();
  });

  it('rejects an empty schedule', () => {
    expect(() => validateBlindSchedule([])).toThrow();
  });

  it('rejects misnumbered levels', () => {
    expect(() => validateBlindSchedule([lvl({ level: 1 }), lvl({ level: 3 })])).toThrow(/numbered/);
  });

  it('rejects non-positive durations and blinds', () => {
    expect(() => validateBlindSchedule([lvl({ level: 1, durationMs: 0 })])).toThrow();
    expect(() => validateBlindSchedule([lvl({ level: 1, smallBlind: 0 })])).toThrow();
    expect(() =>
      validateBlindSchedule([lvl({ level: 1, smallBlind: 30, bigBlind: 20 })]),
    ).toThrow();
    expect(() => validateBlindSchedule([lvl({ level: 1, ante: -1 })])).toThrow();
  });

  it('allows a break level with any blinds for display', () => {
    expect(() =>
      validateBlindSchedule([lvl({ level: 1 }), lvl({ level: 2, isBreak: true, smallBlind: 0 })]),
    ).not.toThrow();
  });
});

describe('blindLevelAt / levelStartMs', () => {
  it('is level 1 from the start', () => {
    expect(blindLevelAt(schedule, 0).level).toBe(1);
    expect(blindLevelAt(schedule, 59_999).level).toBe(1);
  });

  it('rolls to the next level exactly on the boundary', () => {
    expect(blindLevelAt(schedule, 60_000).level).toBe(2);
    expect(blindLevelAt(schedule, 120_000).level).toBe(3);
  });

  it('clamps to the last level once the schedule is exhausted', () => {
    expect(blindLevelAt(schedule, 10_000_000).level).toBe(3);
  });

  it('levelStartMs and totalScheduledMs add up', () => {
    expect(levelStartMs(schedule, 1)).toBe(0);
    expect(levelStartMs(schedule, 2)).toBe(60_000);
    expect(levelStartMs(schedule, 3)).toBe(120_000);
    expect(totalScheduledMs(schedule)).toBe(180_000);
  });
});

describe('standardBlindSchedule', () => {
  it('numbers levels sequentially and never lowers the big blind', () => {
    const s = standardBlindSchedule({
      startingBigBlind: 20,
      levelDurationMs: 600_000,
      levels: 15,
      breakEvery: 5,
      breakDurationMs: 300_000,
    });
    s.forEach((level, i) => expect(level.level).toBe(i + 1));

    const play = s.filter((l) => !l.isBreak);
    for (let i = 1; i < play.length; i += 1) {
      expect(play[i]!.bigBlind).toBeGreaterThanOrEqual(play[i - 1]!.bigBlind);
      expect(play[i]!.smallBlind).toBeLessThanOrEqual(play[i]!.bigBlind);
    }
    expect(play).toHaveLength(15);
    expect(s.filter((l) => l.isBreak).length).toBe(2); // after levels 5 and 10
  });
});
