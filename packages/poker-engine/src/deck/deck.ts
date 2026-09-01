import { type Card, makeCard } from '../cards/card';
import { RANKS } from '../cards/rank';
import { SUITS } from '../cards/suit';

export const DECK_SIZE = 52;

export class DeckExhaustedError extends Error {
  constructor(requested: number, remaining: number) {
    super(`Cannot deal ${requested} card(s): only ${remaining} remaining`);
    this.name = 'DeckExhaustedError';
  }
}

/**
 * Immutable deck state. `cards` is the full 52-card deal order (never mutated);
 * `cursor` is the index of the next card to be dealt. Kept as plain data so it
 * can live inside the engine's GameState and be serialized for hand replay.
 */
export interface DeckState {
  readonly cards: readonly Card[];
  readonly cursor: number;
}

/** A fresh, ordered 52-card deck: Two…Ace within Clubs, Diamonds, Hearts, Spades. */
export function createDeck(): Card[] {
  const cards: Card[] = [];
  for (const rank of RANKS) {
    for (const suit of SUITS) {
      cards.push(makeCard(rank, suit));
    }
  }
  return cards;
}

export function freshDeck(): DeckState {
  return { cards: createDeck(), cursor: 0 };
}

/** Build a deck state from a specific (already-ordered/shuffled) card list. */
export function deckFromCards(cards: readonly Card[]): DeckState {
  if (cards.length !== DECK_SIZE) {
    throw new Error(`A deck must contain exactly ${DECK_SIZE} cards, got ${cards.length}`);
  }
  return { cards: [...cards], cursor: 0 };
}

export function remainingCount(deck: DeckState): number {
  return deck.cards.length - deck.cursor;
}

export function remainingCards(deck: DeckState): readonly Card[] {
  return deck.cards.slice(deck.cursor);
}

/** Deals one card off the top. Returns the card and the advanced deck. */
export function dealCard(deck: DeckState): { card: Card; deck: DeckState } {
  const result = dealCards(deck, 1);
  const card = result.cards[0];
  if (card === undefined) throw new DeckExhaustedError(1, 0);
  return { card, deck: result.deck };
}

/** Deals `count` cards off the top. */
export function dealCards(deck: DeckState, count: number): { cards: Card[]; deck: DeckState } {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`count must be a non-negative integer, got ${count}`);
  }
  if (count > remainingCount(deck)) {
    throw new DeckExhaustedError(count, remainingCount(deck));
  }
  const cards = deck.cards.slice(deck.cursor, deck.cursor + count);
  return { cards, deck: { cards: deck.cards, cursor: deck.cursor + count } };
}

/** Discards one card (the "burn" before dealing a community street). */
export function burnCard(deck: DeckState): { card: Card; deck: DeckState } {
  return dealCard(deck);
}

/** Returns the deck to its starting position without changing card order. */
export function resetDeck(deck: DeckState): DeckState {
  return { cards: deck.cards, cursor: 0 };
}
