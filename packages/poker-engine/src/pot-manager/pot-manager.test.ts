import { HandCategory, type HandRank } from '../hand-evaluator/hand-rank';
import {
  awardPots,
  buildPots,
  type Contribution,
  returnUncalledBet,
  splitAmount,
} from './pot-manager';

const contrib = (seat: number, contributed: number, folded = false): Contribution => ({
  seat,
  contributed,
  folded,
});

const rank = (category: HandCategory, tiebreakers: number[]): HandRank => ({
  category,
  tiebreakers,
  cards: [],
});

const totalOf = (pots: { amount: number }[]) => pots.reduce((s, p) => s + p.amount, 0);
const layout = (cs: Contribution[]) => buildPots(cs);

describe('buildPots', () => {
  it('single pot when everyone contributed equally', () => {
    expect(layout([contrib(1, 100), contrib(2, 100), contrib(3, 100)]).pots).toEqual([
      { amount: 300, eligibleSeats: [1, 2, 3] },
    ]);
  });

  it('folded players add dead money but are never eligible', () => {
    const { pots, deadRefunds } = layout([contrib(1, 100), contrib(2, 100), contrib(3, 60, true)]);
    expect(pots).toEqual([{ amount: 260, eligibleSeats: [1, 2] }]);
    expect(deadRefunds).toEqual([]);
    expect(totalOf(pots)).toBe(260);
  });

  it('one all-in short stack creates a main pot and a side pot', () => {
    const { pots } = layout([contrib(1, 300), contrib(2, 100), contrib(3, 300)]);
    expect(pots).toEqual([
      { amount: 300, eligibleSeats: [1, 2, 3] }, // 100 x 3
      { amount: 400, eligibleSeats: [1, 3] }, // 200 x 2
    ]);
    expect(totalOf(pots)).toBe(700);
  });

  it('two all-ins at different levels create two side pots', () => {
    const { pots } = layout([contrib(1, 500), contrib(2, 100), contrib(3, 250), contrib(4, 500)]);
    expect(pots).toEqual([
      { amount: 400, eligibleSeats: [1, 2, 3, 4] }, // 100 x 4
      { amount: 450, eligibleSeats: [1, 3, 4] }, // 150 x 3
      { amount: 500, eligibleSeats: [1, 4] }, // 250 x 2
    ]);
    expect(totalOf(pots)).toBe(500 + 100 + 250 + 500);
  });

  it('merges adjacent layers that pay the same players (folded creating a level)', () => {
    const { pots } = layout([contrib(1, 100), contrib(2, 200, true), contrib(3, 300)]);
    expect(pots).toEqual([
      { amount: 300, eligibleSeats: [1, 3] },
      { amount: 300, eligibleSeats: [3] },
    ]);
    expect(totalOf(pots)).toBe(600);
  });

  it('refunds a layer that no contesting player reached (all high bettors folded)', () => {
    // seats 1,2,3 all-in for 728/835/891; seats 4,5 bet 1078 then folded
    const { pots, deadRefunds } = layout([
      contrib(1, 728),
      contrib(2, 835),
      contrib(3, 891),
      contrib(4, 1078, true),
      contrib(5, 1078, true),
    ]);
    // top layer 891..1078 (187) contributed only by folded 4 & 5 -> refunded 187 each
    expect(deadRefunds).toEqual([
      { seat: 4, amount: 187 },
      { seat: 5, amount: 187 },
    ]);
    expect(totalOf(pots) + deadRefunds.reduce((s, r) => s + r.amount, 0)).toBe(
      728 + 835 + 891 + 1078 + 1078,
    );
  });

  it('handles a lone contributor and an empty input', () => {
    expect(layout([contrib(1, 20)]).pots).toEqual([{ amount: 20, eligibleSeats: [1] }]);
    expect(layout([])).toEqual({ pots: [], deadRefunds: [] });
  });

  it('never creates or loses chips', () => {
    const { pots, deadRefunds } = layout([
      contrib(1, 173),
      contrib(2, 173),
      contrib(3, 90, true),
      contrib(4, 55),
    ]);
    expect(totalOf(pots) + deadRefunds.reduce((s, r) => s + r.amount, 0)).toBe(173 + 173 + 90 + 55);
  });
});

describe('splitAmount (odd chips)', () => {
  it('splits evenly when it divides', () => {
    expect(splitAmount(300, [1, 2, 3], [1, 2, 3])).toEqual([
      { seat: 1, amount: 100 },
      { seat: 2, amount: 100 },
      { seat: 3, amount: 100 },
    ]);
  });

  it('gives the odd chip(s) to the earliest seats in odd-chip order', () => {
    const split = splitAmount(301, [3, 1], [1, 2, 3]);
    expect(split).toEqual([
      { seat: 1, amount: 151 },
      { seat: 3, amount: 150 },
    ]);
  });

  it('distributes multiple leftover chips one at a time', () => {
    const split = splitAmount(302, [1, 2, 3], [2, 3, 1]);
    expect(split.find((s) => s.seat === 2)?.amount).toBe(101);
    expect(split.find((s) => s.seat === 3)?.amount).toBe(101);
    expect(split.find((s) => s.seat === 1)?.amount).toBe(100);
    expect(split.reduce((s, w) => s + w.amount, 0)).toBe(302);
  });
});

describe('awardPots', () => {
  const order = [1, 2, 3, 4];

  it('awards the whole pot to the single best hand', () => {
    const pots = [{ amount: 300, eligibleSeats: [1, 2, 3] }];
    const ranks = new Map<number, HandRank>([
      [1, rank(HandCategory.Pair, [10])],
      [2, rank(HandCategory.TwoPair, [14, 13, 2])],
      [3, rank(HandCategory.HighCard, [14, 12, 9, 5, 3])],
    ]);
    const awards = awardPots(pots, ranks, order);
    expect(awards[0]?.winners).toEqual([{ seat: 2, amount: 300 }]);
  });

  it('splits a pot between tied hands, odd chip by position', () => {
    const pots = [{ amount: 101, eligibleSeats: [1, 2] }];
    const tie = rank(HandCategory.Straight, [10]);
    const ranks = new Map<number, HandRank>([
      [1, tie],
      [2, { ...tie }],
    ]);
    const awards = awardPots(pots, ranks, [2, 1]);
    expect(awards[0]?.winners).toEqual([
      { seat: 2, amount: 51 },
      { seat: 1, amount: 50 },
    ]);
  });

  it('main pot and side pot can be won by different players', () => {
    // seat 2 is all-in short with the best hand; seat 1 has 2nd best; seat 3 folded-equivalent absent
    const pots = [
      { amount: 300, eligibleSeats: [1, 2, 3] },
      { amount: 400, eligibleSeats: [1, 3] },
    ];
    const ranks = new Map<number, HandRank>([
      [1, rank(HandCategory.Flush, [12, 10, 8, 5, 2])],
      [2, rank(HandCategory.FullHouse, [7, 7])],
      [3, rank(HandCategory.Pair, [9])],
    ]);
    const awards = awardPots(pots, ranks, order);
    expect(awards[0]?.winners).toEqual([{ seat: 2, amount: 300 }]); // main -> best overall
    expect(awards[1]?.winners).toEqual([{ seat: 1, amount: 400 }]); // side -> best of {1,3}
  });

  it('pays out exactly the pot totals', () => {
    const pots = [
      { amount: 250, eligibleSeats: [1, 2, 3] },
      { amount: 133, eligibleSeats: [2, 3] },
    ];
    const ranks = new Map<number, HandRank>([
      [1, rank(HandCategory.Pair, [5])],
      [2, rank(HandCategory.Straight, [9])],
      [3, rank(HandCategory.Straight, [9])],
    ]);
    const awards = awardPots(pots, ranks, [3, 1, 2]);
    const paid = awards.flatMap((a) => a.winners).reduce((s, w) => s + w.amount, 0);
    expect(paid).toBe(383);
  });
});

describe('returnUncalledBet', () => {
  it('returns the excess of a uniquely-highest bet', () => {
    expect(
      returnUncalledBet([
        { seat: 1, currentBet: 500 },
        { seat: 2, currentBet: 300 },
      ]),
    ).toEqual({
      seat: 1,
      amount: 200,
    });
  });

  it('returns nothing when the top bet was matched', () => {
    expect(
      returnUncalledBet([
        { seat: 1, currentBet: 300 },
        { seat: 2, currentBet: 300 },
        { seat: 3, currentBet: 100 },
      ]),
    ).toBeNull();
  });

  it('accounts for a partial (all-in) call as the second-highest', () => {
    expect(
      returnUncalledBet([
        { seat: 1, currentBet: 500 },
        { seat: 2, currentBet: 220 },
      ]),
    ).toEqual({ seat: 1, amount: 280 });
  });
});
