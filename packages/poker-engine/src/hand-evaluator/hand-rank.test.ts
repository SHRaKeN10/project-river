import { compareHandRanks, HandCategory, handCategoryName, type HandRank } from './hand-rank';

const rank = (category: HandCategory, tiebreakers: number[]): HandRank => ({
  category,
  tiebreakers,
  cards: [],
});

describe('compareHandRanks', () => {
  it('orders by category first', () => {
    expect(
      compareHandRanks(rank(HandCategory.Flush, [14]), rank(HandCategory.Straight, [14])),
    ).toBeGreaterThan(0);
    expect(
      compareHandRanks(rank(HandCategory.Pair, [2]), rank(HandCategory.TwoPair, [2, 2, 2])),
    ).toBeLessThan(0);
  });

  it('walks tiebreakers most-significant-first within a category', () => {
    expect(
      compareHandRanks(
        rank(HandCategory.FullHouse, [13, 2]),
        rank(HandCategory.FullHouse, [12, 14]),
      ),
    ).toBeGreaterThan(0);
    expect(
      compareHandRanks(
        rank(HandCategory.TwoPair, [14, 13, 5]),
        rank(HandCategory.TwoPair, [14, 13, 4]),
      ),
    ).toBeGreaterThan(0);
  });

  it('returns 0 for identical strength (split pot)', () => {
    expect(
      compareHandRanks(
        rank(HandCategory.Flush, [14, 12, 9, 5, 3]),
        rank(HandCategory.Flush, [14, 12, 9, 5, 3]),
      ),
    ).toBe(0);
  });

  it('treats a missing tiebreaker as 0', () => {
    expect(
      compareHandRanks(rank(HandCategory.Straight, [6]), rank(HandCategory.Straight, [6, 0])),
    ).toBe(0);
  });
});

describe('handCategoryName', () => {
  it('names every category', () => {
    for (let c = HandCategory.HighCard; c <= HandCategory.StraightFlush; c += 1) {
      expect(handCategoryName(c).length).toBeGreaterThan(0);
    }
    expect(handCategoryName(HandCategory.FullHouse)).toBe('Full House');
  });
});
