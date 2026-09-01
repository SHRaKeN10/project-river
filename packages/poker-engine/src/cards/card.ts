import { charToRank, isRank, Rank, rankToChar } from './rank';
import { charToSuit, isSuit, Suit, SUITS } from './suit';

/** A playing card. Immutable value object. */
export interface Card {
  readonly rank: Rank;
  readonly suit: Suit;
}

const SUIT_INDEX: Readonly<Record<Suit, number>> = {
  [Suit.Clubs]: 0,
  [Suit.Diamonds]: 1,
  [Suit.Hearts]: 2,
  [Suit.Spades]: 3,
};

export function makeCard(rank: Rank, suit: Suit): Card {
  return { rank, suit };
}

/**
 * A stable id in [0, 51], unique per card. Used for de-duplication, bitset
 * tricks, and compact serialization. `id = (rank - 2) * 4 + suitIndex`.
 */
export function cardId(card: Card): number {
  return (card.rank - Rank.Two) * 4 + SUIT_INDEX[card.suit];
}

export function cardFromId(id: number): Card {
  if (!Number.isInteger(id) || id < 0 || id > 51) {
    throw new Error(`Invalid card id: ${id}`);
  }
  const rank = (Math.floor(id / 4) + Rank.Two) as Rank;
  const suit = SUITS[id % 4];
  if (suit === undefined) throw new Error(`Invalid card id: ${id}`);
  return { rank, suit };
}

export function sameCard(a: Card, b: Card): boolean {
  return a.rank === b.rank && a.suit === b.suit;
}

/** "As", "Td", "2c". */
export function cardToString(card: Card): string {
  return `${rankToChar(card.rank)}${card.suit}`;
}

/** Parses "As" / "10d" / "tc" (case-insensitive suit). Throws on anything else. */
export function parseCard(text: string): Card {
  const trimmed = text.trim();
  const normalized = trimmed.replace(/^10(?=[cdhsCDHS]$)/, 'T');
  if (normalized.length !== 2) {
    throw new Error(`Invalid card: ${JSON.stringify(text)}`);
  }
  const rankChar = normalized[0] as string;
  const suitChar = normalized[1] as string;
  return { rank: charToRank(rankChar), suit: charToSuit(suitChar) };
}

/** "As Kd Qh" / "AsKdQh" -> Card[]. */
export function parseCards(text: string): Card[] {
  const tokens = text.trim().length === 0 ? [] : text.trim().split(/[\s,]+/);
  const expanded = tokens.flatMap((token) => {
    if (token.length <= 2) return [token];
    // "AsKdQh" -> ["As","Kd","Qh"]
    const pairs = token.match(/(10|[2-9TtJjQqKkAa])[cdhsCDHS]/g);
    if (!pairs || pairs.join('').length !== token.length) {
      throw new Error(`Invalid card group: ${JSON.stringify(token)}`);
    }
    return pairs;
  });
  return expanded.map(parseCard);
}

export function cardsToString(cards: readonly Card[]): string {
  return cards.map(cardToString).join(' ');
}

export function isCard(value: unknown): value is Card {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { rank?: unknown; suit?: unknown };
  return (
    typeof candidate.rank === 'number' &&
    isRank(candidate.rank) &&
    typeof candidate.suit === 'string' &&
    isSuit(candidate.suit)
  );
}

/** True if every card in the list is distinct. */
export function allDistinct(cards: readonly Card[]): boolean {
  const seen = new Set<number>();
  for (const card of cards) {
    const id = cardId(card);
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}
