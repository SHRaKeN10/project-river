/**
 * Card suits. The single-character values double as the wire/string format
 * ("s" = spades). Suits are unordered in poker - no suit beats another - so
 * there is deliberately no comparison helper.
 */
export enum Suit {
  Clubs = 'c',
  Diamonds = 'd',
  Hearts = 'h',
  Spades = 's',
}

/** Canonical iteration order (used when building a fresh deck). */
export const SUITS: readonly Suit[] = [Suit.Clubs, Suit.Diamonds, Suit.Hearts, Suit.Spades];

const SUIT_NAMES: Readonly<Record<Suit, string>> = {
  [Suit.Clubs]: 'Clubs',
  [Suit.Diamonds]: 'Diamonds',
  [Suit.Hearts]: 'Hearts',
  [Suit.Spades]: 'Spades',
};

export function charToSuit(char: string): Suit {
  switch (char.toLowerCase()) {
    case 'c':
      return Suit.Clubs;
    case 'd':
      return Suit.Diamonds;
    case 'h':
      return Suit.Hearts;
    case 's':
      return Suit.Spades;
    default:
      throw new Error(`Invalid suit character: ${JSON.stringify(char)}`);
  }
}

export function suitToChar(suit: Suit): string {
  return suit;
}

export function suitName(suit: Suit): string {
  return SUIT_NAMES[suit];
}

export function isSuit(value: string): value is Suit {
  return (
    value === Suit.Clubs ||
    value === Suit.Diamonds ||
    value === Suit.Hearts ||
    value === Suit.Spades
  );
}
