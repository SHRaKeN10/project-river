import { describeHand, evaluateHand } from '../hand-evaluator/evaluate';
import { type HandRank } from '../hand-evaluator/hand-rank';
import { describeLow, evaluateLow, type LowRank } from '../hand-evaluator/low';
import { type HandRankSummary, type LowHandSummary } from '../events/events';
import { contestingPlayers, type GameState } from '../game-state/game-state';
import { firstToActPostflop } from '../table/table';
import { rulesFor } from '../variant/variant';

/**
 * Order in which hands are revealed at showdown: the last player to bet or
 * raise on the river shows first, then clockwise. If the river checked through,
 * the first player left of the button shows first.
 */
export function showdownOrder(state: GameState): number[] {
  const seats = contestingPlayers(state)
    .map((p) => p.seatNumber)
    .sort((a, b) => a - b);
  if (seats.length === 0) return [];

  const start =
    state.round.lastAggressorSeat !== null && seats.includes(state.round.lastAggressorSeat)
      ? state.round.lastAggressorSeat
      : (firstToActPostflop(state.buttonSeat, seats) ?? seats[0]);

  const startIndex = seats.findIndex((s) => s === start);
  const pivot = startIndex === -1 ? 0 : startIndex;
  return [...seats.slice(pivot), ...seats.slice(0, pivot)];
}

/** Evaluates the best 5-card hand for every player still contesting the pot,
 * honouring the table variant's board-usage rule (Omaha must play exactly two
 * hole cards). */
export function evaluateShowdown(state: GameState): Map<number, HandRank> {
  const { holeCardsUsed } = rulesFor(state.config.variant);
  const result = new Map<number, HandRank>();
  for (const player of contestingPlayers(state)) {
    result.set(
      player.seatNumber,
      evaluateHand(player.holeCards, state.communityCards, holeCardsUsed),
    );
  }
  return result;
}

export function summarizeHand(rank: HandRank): HandRankSummary {
  return {
    category: rank.category,
    tiebreakers: rank.tiebreakers,
    cards: rank.cards,
    description: describeHand(rank),
  };
}

/**
 * Best qualifying low for every contesting seat that has one. Empty for every
 * non-hi/lo variant, so callers can treat "no low map entry" as "no low".
 */
export function evaluateLowShowdown(state: GameState): Map<number, LowRank> {
  const { hiLo, holeCardsUsed, lowQualifier } = rulesFor(state.config.variant);
  const result = new Map<number, LowRank>();
  if (!hiLo || lowQualifier === null) return result;
  const used = holeCardsUsed ?? 2;
  for (const player of contestingPlayers(state)) {
    const low = evaluateLow(player.holeCards, state.communityCards, used, lowQualifier);
    if (low) result.set(player.seatNumber, low);
  }
  return result;
}

export function summarizeLow(rank: LowRank): LowHandSummary {
  return { ranks: rank.ranks, description: describeLow(rank) };
}
