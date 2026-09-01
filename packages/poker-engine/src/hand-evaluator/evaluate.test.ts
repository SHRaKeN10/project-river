import fc from 'fast-check';
import { type Card, parseCards, Rank } from '../cards';
import { createDeck } from '../deck/deck';
import { SeededRandomProvider } from '../rng/random-provider';
import { shuffle } from '../shuffle/shuffle';
import { compareHandRanks, HandCategory } from './hand-rank';
import { describeHand, evaluate, evaluate5 } from './evaluate';

const h = (notation: string) => evaluate(parseCards(notation));
const cat = (notation: string) => h(notation).category;
/** sign of a-vs-b: 1 = a wins, -1 = b wins, 0 = split */
const cmp = (a: string, b: string): number => Math.sign(compareHandRanks(h(a), h(b)));

describe('hand-evaluator: category detection', () => {
  it.each([
    ['As Ks Qs Js Ts', HandCategory.StraightFlush],
    ['9h 8h 7h 6h 5h', HandCategory.StraightFlush],
    ['5c 4c 3c 2c Ac', HandCategory.StraightFlush], // steel wheel
    ['Ah Ad Ac As Kd', HandCategory.FourOfAKind],
    ['Kh Kd Kc 7s 7d', HandCategory.FullHouse],
    ['Ah Jh 9h 5h 2h', HandCategory.Flush],
    ['9c 8d 7h 6s 5c', HandCategory.Straight],
    ['Ah 2d 3c 4s 5h', HandCategory.Straight], // wheel
    ['Qh Qd Qc 9s 4d', HandCategory.ThreeOfAKind],
    ['Ah Ad Kh Kd 3c', HandCategory.TwoPair],
    ['Th Td 8c 5s 2h', HandCategory.Pair],
    ['Ah Kd 9c 7s 3h', HandCategory.HighCard],
  ])('%s -> %s', (cards, expected) => {
    expect(cat(cards)).toBe(expected);
  });

  it('a broadway straight flush is the strongest hand', () => {
    const royal = h('As Ks Qs Js Ts');
    expect(royal.category).toBe(HandCategory.StraightFlush);
    expect(describeHand(royal)).toBe('Royal Flush');
    for (const other of ['Ah Ad Ac As Kd', 'Kh Kd Kc Ks Qh', '9h 8h 7h 6h 5h']) {
      expect(cmp('As Ks Qs Js Ts', other)).toBe(1);
    }
  });
});

describe('hand-evaluator: straights and the wheel', () => {
  it('ranks the wheel as a Five-high straight, below a Six-high straight', () => {
    expect(cmp('6c 5d 4h 3s 2c', 'Ah 2d 3c 4s 5h')).toBe(1);
  });

  it('the wheel still beats Ace-high (no straight)', () => {
    expect(cmp('Ah 2d 3c 4s 5h', 'Ah Kd Qc Js 9h')).toBe(1);
  });

  it('a wheel straight flush loses to a Six-high straight flush', () => {
    expect(cmp('6c 5c 4c 3c 2c', 'Ac 2c 3c 4c 5c')).toBe(1);
  });

  it('A-K-Q-J-T is a straight, not a wheel', () => {
    const rank = h('Ah Kd Qc Js Th');
    expect(rank.category).toBe(HandCategory.Straight);
    expect(rank.tiebreakers).toEqual([Rank.Ace]);
  });

  it('K-A-2-3-4 is not a straight (Ace does not wrap)', () => {
    expect(cat('Kh Ad 2c 3s 4h')).toBe(HandCategory.HighCard);
  });
});

describe('hand-evaluator: kickers and tie-breaking', () => {
  it('four of a kind: higher kicker wins', () => {
    expect(cmp('7h 7d 7c 7s Ah', '7h 7d 7c 7s Kd')).toBe(1);
  });

  it('full house: trips rank dominates the pair rank', () => {
    expect(cmp('2h 2d 2c Ah Ad', 'Kh Kd Kc 3s 3d')).toBe(-1);
  });

  it('flush: compared card-by-card from the top', () => {
    expect(cmp('Ah Qh 9h 5h 3h', 'Ah Qh 9h 5h 2h')).toBe(1);
    expect(cmp('Kh Qh Jh 9h 7h', 'Kh Qh Jh 9h 7h')).toBe(0);
  });

  it('three of a kind: kickers break the tie', () => {
    expect(cmp('9h 9d 9c Ah Qd', '9h 9d 9c Ah Jd')).toBe(1);
  });

  it('two pair: higher pair, then lower pair, then kicker', () => {
    expect(cmp('Ah Ad 5c 5s Kh', 'Kh Kd 5c 5s Ah')).toBe(1);
    expect(cmp('Ah Ad 9c 9s Kh', 'Ah Ad 8c 8s Kh')).toBe(1);
    expect(cmp('Ah Ad 9c 9s Kh', 'Ah Ad 9c 9s Qh')).toBe(1);
  });

  it('one pair: three kickers break the tie', () => {
    expect(cmp('Jh Jd Ah Kd 8c', 'Jh Jd Ah Kd 7c')).toBe(1);
    expect(cmp('Jh Jd Ah Kd 8c', 'Jh Jd Ah Kd 8s')).toBe(0);
  });

  it('high card: all five cards matter', () => {
    expect(cmp('Ah Kd Qc Js 9h', 'Ah Kd Qc Js 8h')).toBe(1);
  });
});

describe('hand-evaluator: 7-card selection', () => {
  it('finds the best 5 of 7', () => {
    // board makes a flush; the two off-suit hole cards are irrelevant
    const rank = h('Ah Kh 7h 4h 2h  9s 3d');
    expect(rank.category).toBe(HandCategory.Flush);
    expect(rank.tiebreakers).toEqual([Rank.Ace, Rank.King, Rank.Seven, Rank.Four, Rank.Two]);
  });

  it('a player can "play the board" for a split', () => {
    const board = 'As Ks Qs Js Ts';
    const alice = evaluate(parseCards(`${board} 2c 3d`));
    const bob = evaluate(parseCards(`${board} 4h 5c`));
    expect(compareHandRanks(alice, bob)).toBe(0);
  });

  it('uses hole cards when they beat the board', () => {
    const board = '7h 7d 2c 5s 9h';
    const withHole = evaluate(parseCards(`${board} 7c 7s`)); // quad sevens
    const boardOnly = evaluate(parseCards(`${board} Ac Kd`)); // pair of sevens
    expect(withHole.category).toBe(HandCategory.FourOfAKind);
    expect(boardOnly.category).toBe(HandCategory.Pair);
    expect(compareHandRanks(withHole, boardOnly)).toBeGreaterThan(0);
  });

  it('accepts 6 cards too', () => {
    expect(() => h('Ah Kh Qh Jh Th 2c')).not.toThrow();
    expect(cat('Ah Kh Qh Jh Th 2c')).toBe(HandCategory.StraightFlush);
  });
});

describe('hand-evaluator: input validation', () => {
  it('evaluate5 rejects the wrong number of cards', () => {
    expect(() => evaluate5(parseCards('Ah Kh Qh Jh'))).toThrow();
    expect(() => evaluate5(parseCards('Ah Kh Qh Jh Th 9h'))).toThrow();
  });

  it('rejects duplicate cards', () => {
    expect(() => h('Ah Ah Kd Qc Js')).toThrow();
    expect(() => h('Ah Kh Qh Jh Th Ah 2c')).toThrow();
  });

  it('evaluate rejects <5 or >7 cards', () => {
    expect(() => evaluate(parseCards('Ah Kh Qh Jh'))).toThrow();
    expect(() => evaluate(parseCards('Ah Kh Qh Jh Th 9h 8h 7h'))).toThrow();
  });
});

describe('hand-evaluator: describeHand', () => {
  it.each([
    ['As Ks Qs Js Ts', 'Royal Flush'],
    ['9h 8h 7h 6h 5h', 'Straight Flush, Nine high'],
    ['Ah Ad Ac As Kd', 'Four of a Kind, Aces'],
    ['Kh Kd Kc 3s 3d', 'Full House, Kings full of Threes'],
    ['Ah Jh 9h 5h 2h', 'Flush, Ace high'],
    ['9c 8d 7h 6s 5c', 'Straight, Nine high'],
    ['Ah 2d 3c 4s 5h', 'Straight, Five high'],
    ['Qh Qd Qc 9s 4d', 'Three of a Kind, Queens'],
    ['Ah Ad Kh Kd 3c', 'Two Pair, Aces and Kings'],
    ['Th Td 8c 5s 2h', 'Pair of Tens'],
    ['Ah Kd 9c 7s 3h', 'Ace high'],
  ])('%s -> "%s"', (cards, description) => {
    expect(describeHand(h(cards))).toBe(description);
  });
});

describe('hand-evaluator: properties (fast-check)', () => {
  const arbSeven = fc
    .integer({ min: 0, max: 2 ** 31 })
    .map((seed) => shuffle(createDeck(), new SeededRandomProvider(seed)).slice(0, 7));

  it('never throws for any 7 distinct cards', () => {
    fc.assert(
      fc.property(arbSeven, (cards) => {
        expect(() => evaluate(cards)).not.toThrow();
      }),
    );
  });

  it('best-of-7 is never weaker than any 5-card subset of the same 7', () => {
    fc.assert(
      fc.property(arbSeven, (seven) => {
        const best = evaluate(seven);
        // check a handful of explicit 5-subsets
        for (let skip = 0; skip < 7; skip += 1) {
          for (let skip2 = skip + 1; skip2 < 7; skip2 += 1) {
            const five = seven.filter((_, i) => i !== skip && i !== skip2);
            expect(compareHandRanks(best, evaluate5(five))).toBeGreaterThanOrEqual(0);
          }
        }
      }),
    );
  });

  it('comparison is reflexive and antisymmetric', () => {
    fc.assert(
      fc.property(arbSeven, arbSeven, (a, b) => {
        const ra = evaluate(a);
        const rb = evaluate(b);
        expect(compareHandRanks(ra, ra)).toBe(0);
        // sign(compare(a,b)) + sign(compare(b,a)) === 0 covers both the
        // strict-order case (1 + -1) and the tie case (0 + 0).
        expect(Math.sign(compareHandRanks(ra, rb)) + Math.sign(compareHandRanks(rb, ra))).toBe(0);
      }),
    );
  });

  it('hand strength is independent of input card order', () => {
    // Note: when several equally-strong 5-card hands exist (e.g. a straight
    // that can use either of two same-rank cards), the representative `cards`
    // may differ by input order - but the strength never does.
    fc.assert(
      fc.property(arbSeven, fc.integer(), (seven, seed) => {
        const reordered = shuffle(seven, new SeededRandomProvider(seed)) as Card[];
        expect(compareHandRanks(evaluate(seven), evaluate(reordered))).toBe(0);
        expect(evaluate(reordered).category).toBe(evaluate(seven).category);
        expect([...evaluate(reordered).tiebreakers]).toEqual([...evaluate(seven).tiebreakers]);
      }),
    );
  });
});
