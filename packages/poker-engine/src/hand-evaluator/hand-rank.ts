import { type Card } from '../cards/card';

/** Poker hand categories, ordered weakest (1) to strongest (9). A Royal Flush
 * is just the highest possible StraightFlush - it is not a separate category. */
export enum HandCategory {
  HighCard = 1,
  Pair = 2,
  TwoPair = 3,
  ThreeOfAKind = 4,
  Straight = 5,
  Flush = 6,
  FullHouse = 7,
  FourOfAKind = 8,
  StraightFlush = 9,
}

const CATEGORY_NAMES: Readonly<Record<HandCategory, string>> = {
  [HandCategory.HighCard]: 'High Card',
  [HandCategory.Pair]: 'Pair',
  [HandCategory.TwoPair]: 'Two Pair',
  [HandCategory.ThreeOfAKind]: 'Three of a Kind',
  [HandCategory.Straight]: 'Straight',
  [HandCategory.Flush]: 'Flush',
  [HandCategory.FullHouse]: 'Full House',
  [HandCategory.FourOfAKind]: 'Four of a Kind',
  [HandCategory.StraightFlush]: 'Straight Flush',
};

export function handCategoryName(category: HandCategory): string {
  return CATEGORY_NAMES[category];
}

/**
 * The strength of a specific 5-card hand.
 *
 * `tiebreakers` holds the rank values that break ties *within* the same
 * category, most-significant first. Two hands in the same category are compared
 * by walking these arrays (which are always the same length for a given
 * category). Examples:
 *   - FullHouse -> [tripsRank, pairRank]
 *   - TwoPair   -> [higherPairRank, lowerPairRank, kickerRank]
 *   - Flush / HighCard -> all five ranks, descending
 *   - Straight / StraightFlush -> [highRank]  (the wheel's high is Five)
 *
 * `cards` are the exact five cards that make the hand, ordered for display
 * (contributing cards first, then kickers, each group descending).
 */
export interface HandRank {
  readonly category: HandCategory;
  readonly tiebreakers: readonly number[];
  readonly cards: readonly Card[];
}

/**
 * Total order on hand strength. Returns a negative number if `a` is weaker,
 * positive if `a` is stronger, and 0 for an exact tie (a split pot).
 */
export function compareHandRanks(a: HandRank, b: HandRank): number {
  if (a.category !== b.category) return a.category - b.category;
  const length = Math.max(a.tiebreakers.length, b.tiebreakers.length);
  for (let i = 0; i < length; i += 1) {
    const left = a.tiebreakers[i] ?? 0;
    const right = b.tiebreakers[i] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}
