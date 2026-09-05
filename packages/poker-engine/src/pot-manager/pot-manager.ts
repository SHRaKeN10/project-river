import { compareHandRanks, type HandRank } from '../hand-evaluator/hand-rank';
import { compareLowRanks, type LowRank } from '../hand-evaluator/low';
import { type Pot } from '../game-state/game-state';

export interface Contribution {
  readonly seat: number;
  /** Total chips this player has put into the pot this hand (net of any
   * uncalled bet already returned to them). */
  readonly contributed: number;
  readonly folded: boolean;
}

export interface PotLayout {
  readonly pots: Pot[];
  /**
   * Chips in a layer that no non-folded player contested - returned to the
   * (folded) players who put them in. Happens when everyone who bet above the
   * level the contesting players reached then folded.
   */
  readonly deadRefunds: { seat: number; amount: number }[];
}

/**
 * Builds the ordered main + side pots from each player's total contribution.
 *
 * The classic layered algorithm: for each distinct contribution level, take the
 * slice `(level - previousLevel)` from every player who reached it. Folded
 * players' chips are still in the pot ("dead money") but they are never
 * eligible to win. Adjacent layers with the same eligible set are merged. A
 * layer contested by nobody is refunded to its (folded) contributors.
 *
 * Uncalled bets from the live betting rounds must already have been refunded
 * before calling this - see `returnUncalledBet`.
 */
export function buildPots(contributions: readonly Contribution[]): PotLayout {
  const contributing = contributions.filter((c) => c.contributed > 0);
  if (contributing.length === 0) return { pots: [], deadRefunds: [] };

  const levels = [...new Set(contributing.map((c) => c.contributed))].sort((a, b) => a - b);

  const layers: Pot[] = [];
  const deadRefunds: { seat: number; amount: number }[] = [];
  let previous = 0;
  for (const level of levels) {
    const slice = level - previous;
    previous = level;
    if (slice === 0) continue;

    const contributorsAtLevel = contributing.filter((c) => c.contributed >= level);
    const eligibleSeats = contributorsAtLevel
      .filter((c) => !c.folded)
      .map((c) => c.seat)
      .sort((a, b) => a - b);

    if (eligibleSeats.length === 0) {
      // Nobody contesting reached this level - return each contributor's slice.
      for (const contributor of contributorsAtLevel) {
        deadRefunds.push({ seat: contributor.seat, amount: slice });
      }
      continue;
    }
    layers.push({ amount: slice * contributorsAtLevel.length, eligibleSeats });
  }

  // Merge consecutive layers that pay the same set of players.
  const merged: Pot[] = [];
  for (const layer of layers) {
    const last = merged[merged.length - 1];
    if (last && sameSeats(last.eligibleSeats, layer.eligibleSeats)) {
      merged[merged.length - 1] = {
        amount: last.amount + layer.amount,
        eligibleSeats: last.eligibleSeats,
      };
    } else {
      merged.push(layer);
    }
  }
  return { pots: merged, deadRefunds: mergeRefunds(deadRefunds) };
}

function mergeRefunds(
  refunds: readonly { seat: number; amount: number }[],
): { seat: number; amount: number }[] {
  const bySeat = new Map<number, number>();
  for (const r of refunds) bySeat.set(r.seat, (bySeat.get(r.seat) ?? 0) + r.amount);
  return [...bySeat.entries()]
    .map(([seat, amount]) => ({ seat, amount }))
    .sort((a, b) => a.seat - b.seat);
}

export interface PotAward {
  readonly potIndex: number;
  readonly amount: number;
  readonly winners: readonly { readonly seat: number; readonly amount: number }[];
}

/**
 * Distributes each pot to the strongest eligible hand(s).
 *
 * @param rankBySeat evaluated hand strength for every seat that reached
 *   showdown (folded seats are absent).
 * @param oddChipOrder seats in the order the odd chip is awarded on a split -
 *   the first seat left of the button, clockwise. Any seat not listed sorts last.
 */
export function awardPots(
  pots: readonly Pot[],
  rankBySeat: ReadonlyMap<number, HandRank>,
  oddChipOrder: readonly number[],
): PotAward[] {
  return pots.map((pot, potIndex) => {
    const contenders = pot.eligibleSeats.filter((seat) => rankBySeat.has(seat));

    // Nobody eligible reached showdown (everyone folded): the lone remaining
    // eligible seat, if any, takes it; otherwise the chips are dead (shouldn't
    // happen in a well-formed hand, but never lose chips).
    if (contenders.length === 0) {
      const fallback = pot.eligibleSeats[0];
      return {
        potIndex,
        amount: pot.amount,
        winners: fallback === undefined ? [] : [{ seat: fallback, amount: pot.amount }],
      };
    }

    let best = rankBySeat.get(contenders[0] as number) as HandRank;
    for (const seat of contenders) {
      const rank = rankBySeat.get(seat) as HandRank;
      if (compareHandRanks(rank, best) > 0) best = rank;
    }
    const winners = contenders.filter(
      (seat) => compareHandRanks(rankBySeat.get(seat) as HandRank, best) === 0,
    );

    return {
      potIndex,
      amount: pot.amount,
      winners: splitAmount(pot.amount, winners, oddChipOrder),
    };
  });
}

export interface HiLoPotAward {
  readonly potIndex: number;
  readonly amount: number;
  /** High-half winners (or whole-pot winners when `lo` is empty). */
  readonly hi: { seat: number; amount: number }[];
  /** Low-half winners; empty when no eligible seat made a qualifying low. */
  readonly lo: { seat: number; amount: number }[];
}

/**
 * Distributes each pot as an eight-or-better hi/lo split.
 *
 * The high half goes to the strongest eligible high hand(s); the low half to
 * the best eligible qualifying low(s). When no eligible seat has a qualifying
 * low, the high hand takes the whole pot. An odd chip in the pot goes to the
 * high side; odd chips *within* a side go by `oddChipOrder`. A player who wins
 * both halves ("scoop") simply appears in both lists.
 */
export function awardPotsHiLo(
  pots: readonly Pot[],
  hiBySeat: ReadonlyMap<number, HandRank>,
  loBySeat: ReadonlyMap<number, LowRank>,
  oddChipOrder: readonly number[],
): HiLoPotAward[] {
  return pots.map((pot, potIndex) => {
    const hiContenders = pot.eligibleSeats.filter((seat) => hiBySeat.has(seat));

    if (hiContenders.length === 0) {
      const fallback = pot.eligibleSeats[0];
      return {
        potIndex,
        amount: pot.amount,
        hi: fallback === undefined ? [] : [{ seat: fallback, amount: pot.amount }],
        lo: [],
      };
    }

    const hiWinners = bestOf(hiContenders, (s) => hiBySeat.get(s) as HandRank, compareHandRanks);
    const loContenders = pot.eligibleSeats.filter((seat) => loBySeat.has(seat));
    const loWinners =
      loContenders.length === 0
        ? []
        : bestOf(loContenders, (s) => loBySeat.get(s) as LowRank, compareLowRanks);

    if (loWinners.length === 0) {
      return {
        potIndex,
        amount: pot.amount,
        hi: splitAmount(pot.amount, hiWinners, oddChipOrder),
        lo: [],
      };
    }

    const loShare = Math.floor(pot.amount / 2);
    const hiShare = pot.amount - loShare; // odd chip to the high hand
    return {
      potIndex,
      amount: pot.amount,
      hi: splitAmount(hiShare, hiWinners, oddChipOrder),
      lo: splitAmount(loShare, loWinners, oddChipOrder),
    };
  });
}

/** Seats whose ranked value ties the best value under `cmp` (cmp > 0 = better). */
function bestOf<T>(
  seats: readonly number[],
  rankOf: (seat: number) => T,
  cmp: (a: T, b: T) => number,
): number[] {
  let best = rankOf(seats[0] as number);
  for (const seat of seats) {
    const r = rankOf(seat);
    if (cmp(r, best) > 0) best = r;
  }
  return seats.filter((seat) => cmp(rankOf(seat), best) === 0);
}

/** Splits `amount` among `winners`; the remainder ("odd chips") goes one at a
 * time to winners in `oddChipOrder`. */
export function splitAmount(
  amount: number,
  winners: readonly number[],
  oddChipOrder: readonly number[],
): { seat: number; amount: number }[] {
  const n = winners.length;
  if (n === 0) return [];
  const base = Math.floor(amount / n);
  let remainder = amount - base * n;

  const ordered = [...winners].sort(
    (a, b) => orderIndex(a, oddChipOrder) - orderIndex(b, oddChipOrder),
  );
  return ordered.map((seat) => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return { seat, amount: base + extra };
  });
}

/**
 * Returns any uncalled portion of the largest bet to that player, so it is not
 * swept into a side pot. Only applies when exactly one player is uniquely the
 * highest bettor this round.
 */
export function returnUncalledBet(
  bets: readonly { seat: number; currentBet: number }[],
): { seat: number; amount: number } | null {
  if (bets.length < 2) {
    const only = bets[0];
    return only && only.currentBet > 0 ? { seat: only.seat, amount: only.currentBet } : null;
  }
  const sorted = [...bets].sort((a, b) => b.currentBet - a.currentBet);
  const top = sorted[0];
  const second = sorted[1];
  if (!top || !second) return null;
  if (top.currentBet <= second.currentBet) return null;
  return { seat: top.seat, amount: top.currentBet - second.currentBet };
}

function sameSeats(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((seat, i) => seat === b[i]);
}

function orderIndex(seat: number, order: readonly number[]): number {
  const index = order.indexOf(seat);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}
