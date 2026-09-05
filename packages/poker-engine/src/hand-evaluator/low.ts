import { type Card } from '../cards/card';
import { Rank } from '../cards/rank';
import { combinations } from './evaluate';

/**
 * A qualifying low hand: five distinct low-card ranks (ace counts as 1), sorted
 * descending. Straights and flushes never count against a low, so only the
 * ranks matter. A *lower* vector is a *better* low - `A-2-3-4-5` (the "wheel")
 * is the nut low.
 */
export interface LowRank {
  /** Length 5, descending, each value in 1..qualifier. */
  readonly ranks: readonly number[];
}

/** Ace plays low; every other rank keeps its value. */
function lowValue(rank: Rank): number {
  return rank === Rank.Ace ? 1 : rank;
}

/**
 * The best qualifying low using exactly `holeCardsUsed` hole cards and the rest
 * from the board (Omaha's split rule applies to the low too, and the two hole
 * cards need not be the ones used for the high). Returns `null` when no
 * five-card combination is five distinct ranks all at or below `qualifier`.
 */
export function evaluateLow(
  hole: readonly Card[],
  board: readonly Card[],
  holeCardsUsed: number,
  qualifier: number,
): LowRank | null {
  const boardCount = 5 - holeCardsUsed;
  if (hole.length < holeCardsUsed || board.length < boardCount) return null;

  let best: LowRank | null = null;
  for (const holePart of combinations(hole, holeCardsUsed)) {
    for (const boardPart of combinations(board, boardCount)) {
      const candidate = lowOf([...holePart, ...boardPart], qualifier);
      if (candidate && (best === null || compareLowRanks(candidate, best) > 0)) {
        best = candidate;
      }
    }
  }
  return best;
}

function lowOf(cards: readonly Card[], qualifier: number): LowRank | null {
  const values = new Set(cards.map((c) => lowValue(c.rank)));
  if (values.size !== 5) return null; // a pair (or fewer distinct ranks) can't be a low
  for (const v of values) if (v > qualifier) return null; // a 9 or higher doesn't qualify
  return { ranks: [...values].sort((a, b) => b - a) };
}

/**
 * Total order on low strength, matching `compareHandRanks`: returns a positive
 * number if `a` is the **better** (lower) low, negative if worse, 0 for an
 * exact tie (a quartered low).
 */
export function compareLowRanks(a: LowRank, b: LowRank): number {
  for (let i = 0; i < 5; i += 1) {
    const av = a.ranks[i] ?? 0;
    const bv = b.ranks[i] ?? 0;
    if (av !== bv) return bv - av; // the lower rank at the first difference wins
  }
  return 0;
}

/** "8-6-4-2-A low" / "5-4-3-2-A low" (the wheel). */
export function describeLow(rank: LowRank): string {
  const name = (v: number): string => (v === 1 ? 'A' : String(v));
  return `${rank.ranks.map(name).join('-')} low`;
}
