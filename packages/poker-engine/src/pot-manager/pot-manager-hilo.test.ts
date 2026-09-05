import { HandCategory, type HandRank } from '../hand-evaluator/hand-rank';
import { type LowRank } from '../hand-evaluator/low';
import { type Pot } from '../game-state/game-state';
import { awardPotsHiLo } from './pot-manager';

const hi = (category: HandCategory, tiebreakers: number[]): HandRank => ({
  category,
  tiebreakers,
  cards: [],
});
const lo = (ranks: number[]): LowRank => ({ ranks });

const pot = (amount: number, eligibleSeats: number[]): Pot => ({ amount, eligibleSeats });
const sumWinners = (ws: { amount: number }[]) => ws.reduce((t, w) => t + w.amount, 0);

describe('awardPotsHiLo', () => {
  const order = [1, 2, 3]; // odd-chip order

  it('the high hand takes the whole pot when no low qualifies', () => {
    const [award] = awardPotsHiLo(
      [pot(300, [1, 2])],
      new Map([
        [1, hi(HandCategory.ThreeOfAKind, [8])],
        [2, hi(HandCategory.Pair, [5])],
      ]),
      new Map(), // no lows
      order,
    );
    expect(award!.hi).toEqual([{ seat: 1, amount: 300 }]);
    expect(award!.lo).toEqual([]);
  });

  it('splits high/low, the odd chip going to the high side', () => {
    const [award] = awardPotsHiLo(
      [pot(301, [1, 2])],
      new Map([
        [1, hi(HandCategory.ThreeOfAKind, [8])],
        [2, hi(HandCategory.Pair, [5])],
      ]),
      new Map([[2, lo([6, 4, 3, 2, 1])]]), // only seat 2 has a low
      order,
    );
    expect(sumWinners(award!.hi)).toBe(151); // ceil(301/2)
    expect(sumWinners(award!.lo)).toBe(150);
    expect(award!.hi).toEqual([{ seat: 1, amount: 151 }]);
    expect(award!.lo).toEqual([{ seat: 2, amount: 150 }]);
  });

  it('a scoop: the same seat wins both halves', () => {
    const [award] = awardPotsHiLo(
      [pot(200, [1, 2])],
      new Map([
        [1, hi(HandCategory.Straight, [8])],
        [2, hi(HandCategory.Pair, [5])],
      ]),
      new Map([[1, lo([5, 4, 3, 2, 1])]]), // seat 1 also has the nut low
      order,
    );
    expect(award!.hi).toEqual([{ seat: 1, amount: 100 }]);
    expect(award!.lo).toEqual([{ seat: 1, amount: 100 }]);
  });

  it('quarters the low between two identical lows', () => {
    const [award] = awardPotsHiLo(
      [pot(400, [1, 2, 3])],
      new Map([
        [1, hi(HandCategory.Flush, [14])],
        [2, hi(HandCategory.Pair, [9])],
        [3, hi(HandCategory.Pair, [8])],
      ]),
      new Map([
        [2, lo([7, 5, 3, 2, 1])],
        [3, lo([7, 5, 3, 2, 1])], // tie
      ]),
      order,
    );
    // seat 1 takes the whole high half (200); seats 2 & 3 quarter the low (100 each)
    expect(award!.hi).toEqual([{ seat: 1, amount: 200 }]);
    expect(award!.lo).toEqual([
      { seat: 2, amount: 100 },
      { seat: 3, amount: 100 },
    ]);
  });

  it('odd chips inside a side go by the odd-chip order', () => {
    const [award] = awardPotsHiLo(
      [pot(10, [1, 2, 3])],
      new Map([
        [1, hi(HandCategory.Pair, [5])],
        [2, hi(HandCategory.Pair, [5])], // tie for high
        [3, hi(HandCategory.HighCard, [9])],
      ]),
      new Map([[3, lo([8, 6, 4, 2, 1])]]),
      [2, 1, 3],
    );
    // high half = 5, split 3/2 with the odd chip to seat 2 (first in order)
    expect(award!.hi).toEqual([
      { seat: 2, amount: 3 },
      { seat: 1, amount: 2 },
    ]);
    expect(award!.lo).toEqual([{ seat: 3, amount: 5 }]);
  });

  it('conserves chips across a main + side pot', () => {
    const awards = awardPotsHiLo(
      [pot(300, [1, 2, 3]), pot(400, [1, 3])],
      new Map([
        [1, hi(HandCategory.ThreeOfAKind, [10])],
        [2, hi(HandCategory.Pair, [5])],
        [3, hi(HandCategory.TwoPair, [9, 8])],
      ]),
      new Map([[2, lo([6, 4, 3, 2, 1])]]),
      order,
    );
    const paid = awards.flatMap((a) => [...a.hi, ...a.lo]).reduce((t, w) => t + w.amount, 0);
    expect(paid).toBe(700);
    // seat 2 only shares the main pot's low half; it is not eligible for the side
    expect(sumWinners(awards[0]!.lo)).toBe(150);
    expect(awards[1]!.lo).toEqual([]); // no low seat eligible for the side pot
  });
});
