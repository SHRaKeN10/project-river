import { allDistinct, type Card, cardsToString } from '../cards/card';
import { Rank, rankName } from '../cards/rank';
import { compareHandRanks, HandCategory, type HandRank } from './hand-rank';

/**
 * Evaluate exactly five distinct cards into a comparable HandRank.
 *
 * Straights (including the A-2-3-4-5 "wheel", ranked as a Five-high straight)
 * and flushes are detected directly; everything else falls out of the
 * rank-frequency grouping.
 */
export function evaluate5(input: readonly Card[]): HandRank {
  if (input.length !== 5) {
    throw new Error(`evaluate5 requires exactly 5 cards, got ${input.length}`);
  }
  if (!allDistinct(input)) {
    throw new Error(`evaluate5 requires distinct cards: ${cardsToString(input)}`);
  }

  const byRankDesc = [...input].sort((a, b) => b.rank - a.rank);
  const ranksDesc = byRankDesc.map((card) => card.rank);

  const firstSuit = byRankDesc[0]?.suit;
  const isFlush = firstSuit !== undefined && byRankDesc.every((card) => card.suit === firstSuit);
  const straightHigh = straightHighRank(ranksDesc);

  const groups = groupByRank(byRankDesc);
  const orderedCards = groups.flatMap((group) => group.cards);
  const groupRanks = groups.map((group) => group.rank);
  const sizes = groups.map((group) => group.count);

  if (straightHigh !== null && isFlush) {
    return {
      category: HandCategory.StraightFlush,
      tiebreakers: [straightHigh],
      cards: straightCards(byRankDesc, straightHigh),
    };
  }
  if (sizes[0] === 4) {
    return { category: HandCategory.FourOfAKind, tiebreakers: groupRanks, cards: orderedCards };
  }
  if (sizes[0] === 3 && sizes[1] === 2) {
    return { category: HandCategory.FullHouse, tiebreakers: groupRanks, cards: orderedCards };
  }
  if (isFlush) {
    return { category: HandCategory.Flush, tiebreakers: ranksDesc, cards: [...byRankDesc] };
  }
  if (straightHigh !== null) {
    return {
      category: HandCategory.Straight,
      tiebreakers: [straightHigh],
      cards: straightCards(byRankDesc, straightHigh),
    };
  }
  if (sizes[0] === 3) {
    return { category: HandCategory.ThreeOfAKind, tiebreakers: groupRanks, cards: orderedCards };
  }
  if (sizes[0] === 2 && sizes[1] === 2) {
    return { category: HandCategory.TwoPair, tiebreakers: groupRanks, cards: orderedCards };
  }
  if (sizes[0] === 2) {
    return { category: HandCategory.Pair, tiebreakers: groupRanks, cards: orderedCards };
  }
  return { category: HandCategory.HighCard, tiebreakers: ranksDesc, cards: [...byRankDesc] };
}

/**
 * Evaluate 5, 6, or 7 cards, returning the strongest 5-card hand. Hold'em
 * showdown always supplies 7 (2 hole + 5 board); 5 and 6 are allowed for
 * intermediate/street evaluation. Best-of-C(n,5) - at most 21 sub-hands.
 */
export function evaluate(cards: readonly Card[]): HandRank {
  if (cards.length === 5) return evaluate5(cards);
  if (cards.length < 5 || cards.length > 7) {
    throw new Error(`evaluate requires 5 to 7 cards, got ${cards.length}`);
  }
  if (!allDistinct(cards)) {
    throw new Error(`evaluate requires distinct cards: ${cardsToString(cards)}`);
  }

  let best: HandRank | null = null;
  for (const combo of combinations5(cards)) {
    const candidate = evaluate5(combo);
    if (best === null || compareHandRanks(candidate, best) > 0) {
      best = candidate;
    }
  }
  if (best === null) {
    throw new Error('no 5-card hand could be formed');
  }
  return best;
}

/** Alias - Hold'em showdown always evaluates 7 cards. */
export const evaluate7 = evaluate;

/** Human-readable summary, e.g. "Full House, Kings full of Threes". */
export function describeHand(rank: HandRank): string {
  const tiebreak = (index: number): Rank => {
    const value = rank.tiebreakers[index];
    return value === undefined ? Rank.Two : (value as Rank);
  };
  switch (rank.category) {
    case HandCategory.StraightFlush:
      return tiebreak(0) === Rank.Ace
        ? 'Royal Flush'
        : `Straight Flush, ${rankName(tiebreak(0))} high`;
    case HandCategory.FourOfAKind:
      return `Four of a Kind, ${rankName(tiebreak(0), true)}`;
    case HandCategory.FullHouse:
      return `Full House, ${rankName(tiebreak(0), true)} full of ${rankName(tiebreak(1), true)}`;
    case HandCategory.Flush:
      return `Flush, ${rankName(tiebreak(0))} high`;
    case HandCategory.Straight:
      return `Straight, ${rankName(tiebreak(0))} high`;
    case HandCategory.ThreeOfAKind:
      return `Three of a Kind, ${rankName(tiebreak(0), true)}`;
    case HandCategory.TwoPair:
      return `Two Pair, ${rankName(tiebreak(0), true)} and ${rankName(tiebreak(1), true)}`;
    case HandCategory.Pair:
      return `Pair of ${rankName(tiebreak(0), true)}`;
    default:
      return `${rankName(tiebreak(0))} high`;
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

interface RankGroup {
  readonly rank: Rank;
  readonly count: number;
  readonly cards: Card[];
}

/** Groups cards by rank, ordered by (count desc, rank desc) - the order that
 * makes `tiebreakers` fall straight out for the paired categories. */
function groupByRank(cards: readonly Card[]): RankGroup[] {
  const byRank = new Map<Rank, Card[]>();
  for (const card of cards) {
    const list = byRank.get(card.rank) ?? [];
    list.push(card);
    byRank.set(card.rank, list);
  }
  return [...byRank.entries()]
    .map(([rank, groupCards]) => ({ rank, count: groupCards.length, cards: groupCards }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);
}

/** Returns the straight's high rank, or null. The wheel (A-2-3-4-5) returns Five. */
function straightHighRank(ranksDesc: readonly Rank[]): Rank | null {
  const distinct = [...new Set(ranksDesc)];
  if (distinct.length !== 5) return null;

  const high = distinct[0];
  const low = distinct[4];
  if (high === undefined || low === undefined) return null;

  // Five distinct ranks spanning exactly four steps are necessarily consecutive.
  if (high - low === 4) return high;

  // Wheel: Ace plays low, the hand is a Five-high straight.
  if (high === Rank.Ace && distinct[1] === Rank.Five && distinct[4] === Rank.Two) {
    return Rank.Five;
  }
  return null;
}

/** Orders the five straight cards for display; the wheel becomes 5-4-3-2-A. */
function straightCards(byRankDesc: readonly Card[], straightHigh: Rank): Card[] {
  const hasAce = byRankDesc.some((card) => card.rank === Rank.Ace);
  if (straightHigh === Rank.Five && hasAce) {
    return [
      ...byRankDesc.filter((card) => card.rank !== Rank.Ace),
      ...byRankDesc.filter((card) => card.rank === Rank.Ace),
    ];
  }
  return [...byRankDesc];
}

/** All 5-card subsets of a 5-to-7 card list. */
function combinations5(cards: readonly Card[]): Card[][] {
  const n = cards.length;
  const result: Card[][] = [];
  for (let a = 0; a < n - 4; a += 1) {
    for (let b = a + 1; b < n - 3; b += 1) {
      for (let c = b + 1; c < n - 2; c += 1) {
        for (let d = c + 1; d < n - 1; d += 1) {
          for (let e = d + 1; e < n; e += 1) {
            const combo = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            if (combo.every((card): card is Card => card !== undefined)) {
              result.push(combo);
            }
          }
        }
      }
    }
  }
  return result;
}
