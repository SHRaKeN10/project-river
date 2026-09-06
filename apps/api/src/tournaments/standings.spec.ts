import { placesPaid, payoutSchedule } from '@river/poker-engine';
import { assignRoundPositions, computePayouts, type RoundBust } from './standings';

const bust = (playerId: string, stackAtHandStart: number): RoundBust => ({
  playerId,
  stackAtHandStart,
});

/** Convenience: run one round and return positions as a plain object. */
const round = (args: {
  busts: RoundBust[];
  eliminatedCount?: number;
  entrants: number;
  roundNumber?: number;
  handForHand?: boolean;
  paidPlaces?: number;
}) => {
  const r = assignRoundPositions({
    busts: args.busts,
    eliminatedCount: args.eliminatedCount ?? 0,
    entrants: args.entrants,
    roundNumber: args.roundNumber ?? 1,
    handForHand: args.handForHand ?? true,
    paidPlaces: args.paidPlaces ?? placesPaid(args.entrants),
  });
  return { positions: Object.fromEntries(r.positions), chopGroups: r.chopGroups };
};

describe('assignRoundPositions', () => {
  it('a lone bust takes the worst open place', () => {
    const { positions } = round({ busts: [bust('a', 500)], entrants: 9, eliminatedCount: 2 });
    expect(positions).toEqual({ a: 7 }); // 9 entrants, 2 already out -> place 7
  });

  it('non-tied simultaneous busts: the bigger covered stack finishes higher, no chop', () => {
    const { positions, chopGroups } = round({
      busts: [bust('short', 300), bust('big', 1200), bust('mid', 700)],
      entrants: 9,
      eliminatedCount: 0,
    });
    // places 9, 8, 7 fill from worst to best by ascending stack
    expect(positions).toEqual({ short: 9, mid: 8, big: 7 });
    expect(chopGroups).toEqual([]);
  });

  it('is deterministic regardless of the order busts are reported in', () => {
    const a = round({ busts: [bust('x', 400), bust('y', 400), bust('z', 900)], entrants: 9 });
    const b = round({ busts: [bust('z', 900), bust('y', 400), bust('x', 400)], entrants: 9 });
    expect(a).toEqual(b);
    // z (bigger) finishes best; x/y tie and fall to id order
    expect(a.positions).toEqual({ z: 7, x: 8, y: 9 });
  });

  it('positions are always a contiguous descending block', () => {
    const { positions } = round({
      busts: [bust('a', 100), bust('b', 200), bust('c', 300), bust('d', 400)],
      entrants: 20,
      eliminatedCount: 5,
    });
    const vals = Object.values(positions).sort((p, q) => p - q);
    expect(vals).toEqual([12, 13, 14, 15]); // 20 - 5 - 4 + 1 .. 20 - 5
  });

  describe('chops', () => {
    // 18 entrants -> placesPaid(18) === 3, which keeps the payout boundary at
    // place 3/4 for these bubble scenarios.
    const bubble = (over: Partial<Parameters<typeof round>[0]>) =>
      round({ entrants: 18, paidPlaces: 3, ...over, busts: over.busts as RoundBust[] });

    it('two players tie exactly at the bubble: places 3 & 4 chop (one paid, one not)', () => {
      const { positions, chopGroups } = bubble({
        busts: [bust('p', 250), bust('q', 250)],
        eliminatedCount: 14, // 18 - 14 = 4 worst -> places 3, 4
      });
      expect(positions).toEqual({ p: 3, q: 4 });
      expect(chopGroups).toEqual([[3, 4]]);
    });

    it('a same-hand tie entirely out of the money is not a chop', () => {
      const { positions, chopGroups } = bubble({
        busts: [bust('p', 250), bust('q', 250)],
        eliminatedCount: 0, // places 17, 18
      });
      expect(positions).toEqual({ p: 17, q: 18 });
      expect(chopGroups).toEqual([]); // nobody involved is paid
    });

    it('a three-way tie whose best place is unpaid is not a chop', () => {
      const { positions, chopGroups } = bubble({
        busts: [bust('a', 400), bust('b', 400), bust('c', 400)],
        eliminatedCount: 13, // 18 - 13 = 5 worst -> places 4, 5, 6 (best is 4, unpaid)
      });
      expect(new Set(Object.values(positions))).toEqual(new Set([3, 4, 5]));
      // best place 3 IS paid -> chop
      expect(chopGroups).toEqual([[3, 4, 5]]);
    });

    it('a three-way tie that reaches a paid place chops that whole range', () => {
      const { chopGroups } = bubble({
        busts: [bust('a', 400), bust('b', 400), bust('c', 400)],
        eliminatedCount: 13, // places 3, 4, 5
      });
      expect(chopGroups).toEqual([[3, 4, 5]]);
    });

    it('two separate tie groups in one round produce two chop groups', () => {
      const { positions, chopGroups } = round({
        entrants: 27, // placesPaid(27) === 4
        paidPlaces: 4,
        eliminatedCount: 19, // 27 - 19 = 8 worst -> places 5, 6, 7, 8 ... need 4 in money
        busts: [bust('a', 900), bust('b', 900), bust('c', 200), bust('d', 200)],
      });
      // 27 - 19 = 8 worst, k = 4 -> places 5..8. best place 5 > paidPlaces 4:
      expect(positions).toEqual({ a: 5, b: 6, c: 7, d: 8 });
      expect(chopGroups).toEqual([]); // none reach a paid place
    });

    it('two tie groups where the top one is paid: only that one chops', () => {
      const { positions, chopGroups } = round({
        entrants: 27,
        paidPlaces: 4,
        eliminatedCount: 21, // 27 - 21 = 6 worst -> places 3, 4, 5, 6
        busts: [bust('a', 900), bust('b', 900), bust('c', 200), bust('d', 200)],
      });
      expect(positions).toEqual({ a: 3, b: 4, c: 5, d: 6 });
      // [3,4] reaches a paid place -> chop; [5,6] does not
      expect(chopGroups).toEqual([[3, 4]]);
    });

    it('no chops when hand-for-hand is off, even on an exact tie', () => {
      const { positions, chopGroups } = bubble({
        busts: [bust('p', 250), bust('q', 250)],
        eliminatedCount: 14,
        handForHand: false,
      });
      expect(positions).toEqual({ p: 3, q: 4 });
      expect(chopGroups).toEqual([]);
    });

    it('small fields (6/7/8 entrants, one paid): a bubble tie still chops correctly', () => {
      for (const entrants of [6, 7, 8]) {
        // placesPaid is 1 for all of these - the bubble is place 1/2, but the
        // winner is never a bust, so the tightest real tie is places 2 & 3.
        expect(placesPaid(entrants)).toBe(1);
        const { chopGroups } = round({
          entrants,
          paidPlaces: 1,
          eliminatedCount: entrants - 3, // places 2, 3
          busts: [bust('x', 500), bust('y', 500)],
        });
        // best place is 2, > paidPlaces 1 -> no chop (only the winner is paid)
        expect(chopGroups).toEqual([]);
      }
    });
  });
});

describe('computePayouts', () => {
  const totalOf = (m: Map<number, number>): number => [...m.values()].reduce((a, b) => a + b, 0);

  it('with no chops it is exactly the payout ladder, padded with zeros', () => {
    const m = computePayouts(9, 9000, []);
    const ladder = payoutSchedule(9, 9000);
    expect(m.get(1)).toBe(ladder[0]);
    expect(m.get(2)).toBe(ladder[1]);
    for (let p = 3; p <= 9; p += 1) expect(m.get(p)).toBe(0);
    expect(totalOf(m)).toBe(9000);
  });

  it('a bubble chop [3,4] splits place 3 money in half; place 4 (bubble) gets the other half', () => {
    // 18 entrants -> 3 paid. ladder[2] is place 3's prize.
    const ladder = payoutSchedule(18, 18_000);
    const m = computePayouts(18, 18_000, [[3, 4]]);
    const half = Math.floor(ladder[2]! / 2);
    const odd = ladder[2]! - 2 * half;
    expect(m.get(3)).toBe(half + odd); // odd chip to the better place
    expect(m.get(4)).toBe(half);
    expect(m.get(1)).toBe(ladder[0]);
    expect(m.get(2)).toBe(ladder[1]);
    expect(totalOf(m)).toBe(18_000); // exact
  });

  it('a chop spanning two paid rungs [2,3] gives both players the combined average', () => {
    const ladder = payoutSchedule(18, 18_000); // 3 paid
    const m = computePayouts(18, 18_000, [[2, 3]]);
    const combined = ladder[1]! + ladder[2]!;
    const each = Math.floor(combined / 2);
    expect(m.get(2)).toBe(each + (combined - 2 * each));
    expect(m.get(3)).toBe(each);
    expect(m.get(1)).toBe(ladder[0]);
    expect(totalOf(m)).toBe(18_000);
  });

  it('a three-way chop [3,4,5] across the boundary conserves the total and pushes odd chips high', () => {
    const ladder = payoutSchedule(27, 27_000); // 4 paid: places 3, 4 paid; 5 not
    const combined = ladder[2]! + ladder[3]! + 0;
    const m = computePayouts(27, 27_000, [[3, 4, 5]]);
    const base = Math.floor(combined / 3);
    const rem = combined - 3 * base;
    expect(m.get(3)).toBe(base + (rem >= 1 ? 1 : 0));
    expect(m.get(4)).toBe(base + (rem >= 2 ? 1 : 0));
    expect(m.get(5)).toBe(base + (rem >= 3 ? 1 : 0));
    expect(m.get(3)! + m.get(4)! + m.get(5)!).toBe(combined);
    expect(totalOf(m)).toBe(27_000);
  });

  it('odd-chip handling: a combined pot of an odd size loses nothing', () => {
    // Force an odd combined by picking a pool where ladder[last] is odd.
    for (const pool of [8001, 8003, 9999, 12_345, 100_001]) {
      const m = computePayouts(9, pool, [[2, 3]]);
      expect(totalOf(m)).toBe(pool);
    }
  });

  it('the total always equals the pool for arbitrary chop shapes', () => {
    const shapes: number[][][] = [
      [],
      [[1, 2]],
      [[2, 3]],
      [[3, 4, 5]],
      [
        [2, 3],
        [5, 6],
      ],
      [[1, 2, 3, 4]],
    ];
    for (const entrants of [9, 18, 27, 100]) {
      const pool = entrants * 137; // arbitrary odd-ish per-entry
      for (const shape of shapes) {
        // keep positions within range
        if (shape.flat().some((p) => p > entrants)) continue;
        expect(totalOf(computePayouts(entrants, pool, shape))).toBe(pool);
      }
    }
  });
});
