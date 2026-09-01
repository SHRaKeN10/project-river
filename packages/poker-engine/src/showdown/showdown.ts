import { evaluate } from '../hand-evaluator/evaluate';
import { describeHand } from '../hand-evaluator/evaluate';
import { type HandRank } from '../hand-evaluator/hand-rank';
import { type HandRankSummary } from '../events/events';
import { contestingPlayers, type GameState } from '../game-state/game-state';
import { firstToActPostflop } from '../table/table';

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

/** Evaluates the best 5-card hand for every player still contesting the pot. */
export function evaluateShowdown(state: GameState): Map<number, HandRank> {
  const result = new Map<number, HandRank>();
  for (const player of contestingPlayers(state)) {
    result.set(player.seatNumber, evaluate([...player.holeCards, ...state.communityCards]));
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
