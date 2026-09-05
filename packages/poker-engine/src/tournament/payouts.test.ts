import { payoutSchedule, placesPaid } from './payouts';

describe('placesPaid', () => {
  it('pays roughly the top eighth, at least one, never more than half', () => {
    expect(placesPaid(2)).toBe(1);
    expect(placesPaid(3)).toBe(1);
    expect(placesPaid(6)).toBe(1);
    expect(placesPaid(9)).toBe(2);
    expect(placesPaid(18)).toBe(3);
    expect(placesPaid(27)).toBe(4);
    expect(placesPaid(100)).toBe(12);
    expect(placesPaid(1000)).toBe(120);
  });

  it('rejects a field of one', () => {
    expect(() => placesPaid(1)).toThrow();
  });
});

describe('payoutSchedule', () => {
  const invariants = (entrants: number, prizePool: number): number[] => {
    const s = payoutSchedule(entrants, prizePool);
    expect(s).toHaveLength(placesPaid(entrants));
    expect(s.reduce((a, b) => a + b, 0)).toBe(prizePool); // exact
    for (const amount of s) expect(amount).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < s.length; i += 1) {
      expect(s[i]!).toBeLessThanOrEqual(s[i - 1]!); // never increases down the ladder
    }
    if (s.length > 1) expect(s[0]!).toBeGreaterThan(s[s.length - 1]!);
    return s;
  };

  it('holds every invariant across a wide range of fields and pools', () => {
    for (const entrants of [2, 3, 5, 9, 18, 27, 40, 100, 333, 1000]) {
      for (const perEntry of [100, 550, 1000, 33]) {
        invariants(entrants, entrants * perEntry);
      }
    }
  });

  it('a 3-handed sit & go pays the winner everything', () => {
    expect(payoutSchedule(3, 3000)).toEqual([3000]);
  });

  it('a 9-entrant field pays two, roughly 65/35', () => {
    const [first, second] = payoutSchedule(9, 9000);
    expect(first! + second!).toBe(9000);
    expect(first! / 9000).toBeCloseTo(0.65, 1);
  });

  it('a 27-entrant field follows the four-place curve', () => {
    const s = payoutSchedule(27, 27_000);
    expect(s).toHaveLength(4);
    expect(s.reduce((a, b) => a + b, 0)).toBe(27_000);
    expect(s[0]! / 27_000).toBeCloseTo(0.4, 1);
  });

  it('a pool that barely covers the places gives one chip each', () => {
    expect(payoutSchedule(27, 4)).toEqual([1, 1, 1, 1]);
  });

  it('rejects a nonsensical pool', () => {
    expect(() => payoutSchedule(9, 0)).toThrow();
    expect(() => payoutSchedule(9, -5)).toThrow();
    expect(() => payoutSchedule(9, 10.5)).toThrow();
    expect(() => payoutSchedule(27, 3)).toThrow(/at least one chip/);
  });
});
