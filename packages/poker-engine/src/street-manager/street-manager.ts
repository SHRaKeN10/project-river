import { type Card } from '../cards/card';
import { burnCard, dealCard, dealCards } from '../deck/deck';
import { type GameState, Street } from '../game-state/game-state';
import { canAct, isInHand, type PlayerState } from '../player/player';

/** Preflop -> Flop -> Turn -> River -> Showdown. Showdown/Complete stay put. */
export function nextStreet(street: Street): Street {
  switch (street) {
    case Street.Waiting:
      return Street.Preflop;
    case Street.Preflop:
      return Street.Flop;
    case Street.Flop:
      return Street.Turn;
    case Street.Turn:
      return Street.River;
    case Street.River:
      return Street.Showdown;
    default:
      return street;
  }
}

/** Seats to be dealt into the hand, clockwise starting from the small blind
 * position (or, on a dead small blind, the empty seat just left of the button). */
export function dealOrder(state: GameState): number[] {
  const seats = state.players
    .filter(isInHand)
    .map((p) => p.seatNumber)
    .sort((a, b) => a - b);
  return rotateToStart(seats, state.smallBlindSeat ?? state.buttonSeat + 1);
}

/** Deals two hole cards to each player in the hand (one card at a time, twice
 * around, starting at the small blind - matching a real deal). */
export function dealHoleCards(state: GameState): {
  state: GameState;
  hands: { seat: number; cards: Card[] }[];
} {
  const order = dealOrder(state);
  const dealt = new Map<number, Card[]>(order.map((seat) => [seat, []]));
  let deck = state.deck;

  for (let round = 0; round < 2; round += 1) {
    for (const seat of order) {
      const result = dealCard(deck);
      deck = result.deck;
      (dealt.get(seat) as Card[]).push(result.card);
    }
  }

  const players = state.players.map((p) =>
    dealt.has(p.seatNumber) ? { ...p, holeCards: dealt.get(p.seatNumber) as Card[] } : p,
  );
  const hands = order.map((seat) => ({ seat, cards: dealt.get(seat) as Card[] }));
  return { state: { ...state, players, deck }, hands };
}

export function dealFlop(state: GameState): { state: GameState; cards: Card[]; burned: Card } {
  const burn = burnCard(state.deck);
  const flop = dealCards(burn.deck, 3);
  return {
    state: { ...state, deck: flop.deck, communityCards: [...state.communityCards, ...flop.cards] },
    cards: flop.cards,
    burned: burn.card,
  };
}

export function dealTurn(state: GameState): { state: GameState; card: Card; burned: Card } {
  return dealOneCommunity(state);
}

export function dealRiver(state: GameState): { state: GameState; card: Card; burned: Card } {
  return dealOneCommunity(state);
}

function dealOneCommunity(state: GameState): { state: GameState; card: Card; burned: Card } {
  const burn = burnCard(state.deck);
  const next = dealCard(burn.deck);
  return {
    state: { ...state, deck: next.deck, communityCards: [...state.communityCards, next.card] },
    card: next.card,
    burned: burn.card,
  };
}

/** No further betting is possible - one or zero players can still act while two
 * or more hold cards. The board should just be run out to showdown. */
export function shouldRunOut(players: readonly PlayerState[]): boolean {
  const inHand = players.filter(isInHand);
  const stillActing = inHand.filter(canAct);
  return inHand.length >= 2 && stillActing.length <= 1;
}

function rotateToStart(seats: readonly number[], startSeat: number): number[] {
  if (seats.length === 0) return [];
  const sorted = [...seats].sort((a, b) => a - b);
  const firstIndex = sorted.findIndex((s) => s >= startSeat);
  const pivot = firstIndex === -1 ? 0 : firstIndex;
  return [...sorted.slice(pivot), ...sorted.slice(0, pivot)];
}
