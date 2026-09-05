import { parseCards } from '../cards';
import { combinations, evaluate, evaluateHand, evaluateOmaha } from './evaluate';
import { compareHandRanks, HandCategory } from './hand-rank';

const hole = (s: string) => parseCards(s);
const board = (s: string) => parseCards(s);

describe('evaluateOmaha - exactly two hole cards + three board cards', () => {
  it('one hole-card suited with a four-flush board is NOT a flush', () => {
    // Hole has a single heart; a flush needs two hole hearts + three board hearts.
    const rank = evaluateOmaha(hole('Ah Ks Qd Jc'), board('2h 7h 9h Th 3s'));
    expect(rank.category).toBeLessThan(HandCategory.Flush);
  });

  it('a genuine flush needs two suited hole cards', () => {
    const rank = evaluateOmaha(hole('Ah Kh Qd Jc'), board('2h 7h 9h Th 3s'));
    expect(rank.category).toBe(HandCategory.Flush);
  });

  it('you cannot play a five-card board straight in Omaha', () => {
    // Board is a made 9-high straight; with off-cards you can't use all five.
    const rank = evaluateOmaha(hole('Ac Kd 2s 3h'), board('5d 6s 7h 8c 9d'));
    expect(rank.category).toBeLessThan(HandCategory.Straight);
  });

  it('but a straight using two hole cards stands', () => {
    const rank = evaluateOmaha(hole('Tc Jd 2s 3h'), board('5d 6s 7h 8c 9d'));
    expect(rank.category).toBe(HandCategory.Straight);
    expect(rank.tiebreakers[0]).toBe(11); // Jack-high straight
  });

  it('reads a full house from a pocket pair and a board trip', () => {
    const rank = evaluateOmaha(hole('Kc Kd 4h 7s'), board('5c 5d 5s Ah 2c'));
    expect(rank.category).toBe(HandCategory.FullHouse);
    // fives full of kings
    expect(rank.tiebreakers.slice(0, 2)).toEqual([5, 13]);
  });

  it('reads two pair from one card in each of two board pairs', () => {
    const rank = evaluateOmaha(hole('As Ks Qh Jd'), board('Ad Kd 2c 7h 9s'));
    expect(rank.category).toBe(HandCategory.TwoPair);
    expect(rank.tiebreakers.slice(0, 2)).toEqual([14, 13]);
  });

  it('the best split wins across all C(4,2)xC(5,3) combinations', () => {
    // Only the 5-6 hole pair completes a straight with 3-4-7 on the board;
    // every other 2-of-4 split is weaker.
    const rank = evaluateOmaha(hole('Ad 2c 5h 6s'), board('3d 4s 7h Kc Qd'));
    expect(rank.category).toBe(HandCategory.Straight);
    expect(rank.tiebreakers[0]).toBe(7); // 3-4-5-6-7
  });
});

describe('evaluateHand dispatch', () => {
  it('holeCardsUsed=null matches plain Hold’em evaluate', () => {
    const h = hole('7c 7s');
    const b = board('7h 2d 9c Ac Kd');
    expect(evaluateHand(h, b, null)).toEqual(evaluate([...h, ...b]));
  });

  it('holeCardsUsed=2 matches evaluateOmaha', () => {
    const h = hole('Ah Kh Qd Jc');
    const b = board('2h 7h 9h Th 3s');
    expect(evaluateHand(h, b, 2)).toEqual(evaluateOmaha(h, b));
  });

  it('Hold’em plays the board, Omaha is forced to exactly three board cards', () => {
    const h = hole('2c 3d');
    // Four aces on the board: Hold'em keeps all four; Omaha may take only three.
    const quadBoard = board('Ac Ah As Ad Kd');
    expect(evaluateHand(h, quadBoard, null).category).toBe(HandCategory.FourOfAKind);
    expect(evaluateHand(h, quadBoard, 2).category).toBe(HandCategory.ThreeOfAKind);

    // A five-card board straight: a chop for everyone in Hold'em, unusable in Omaha.
    const straightBoard = board('9c Tc Jd Qh Ks');
    expect(evaluateHand(h, straightBoard, null).category).toBe(HandCategory.Straight);
    expect(
      compareHandRanks(evaluateHand(h, straightBoard, 2), evaluateHand(h, straightBoard, null)),
    ).toBeLessThan(0);
  });

  it('rejects malformed input', () => {
    expect(() => evaluateOmaha(hole('Ah'), board('2h 7h 9h Th 3s'))).toThrow();
    expect(() => evaluateOmaha(hole('Ah Kh Qd Jc'), board('2h 7h'))).toThrow();
    expect(() => evaluateOmaha(hole('Ah Ah Qd Jc'), board('2h 7h 9h Th 3s'))).toThrow(/distinct/);
  });
});

describe('combinations', () => {
  it('counts match C(n,k)', () => {
    expect(combinations([1, 2, 3, 4], 2)).toHaveLength(6);
    expect(combinations([1, 2, 3, 4, 5], 3)).toHaveLength(10);
    expect(combinations([1, 2, 3], 0)).toEqual([[]]);
    expect(combinations([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
    expect(combinations([1, 2], 5)).toEqual([]);
  });

  it('produces distinct subsets', () => {
    const combos = combinations(['a', 'b', 'c', 'd'], 2).map((c) => c.join(''));
    expect(new Set(combos)).toEqual(new Set(['ab', 'ac', 'ad', 'bc', 'bd', 'cd']));
  });
});
