/**
 * Card ranks as ordered numbers (Two = 2 … Ace = 14). Numeric values make
 * straight detection and hand comparison trivial. The Ace is high here; the
 * wheel straight (A-2-3-4-5) is handled as a special case in the evaluator.
 *
 * The API layer maps these to the string enums in `@river/shared-types` at the
 * wire boundary - the engine deliberately does not depend on that package.
 */
export enum Rank {
  Two = 2,
  Three = 3,
  Four = 4,
  Five = 5,
  Six = 6,
  Seven = 7,
  Eight = 8,
  Nine = 9,
  Ten = 10,
  Jack = 11,
  Queen = 12,
  King = 13,
  Ace = 14,
}

/** All ranks, ascending (Two … Ace). */
export const RANKS: readonly Rank[] = [
  Rank.Two,
  Rank.Three,
  Rank.Four,
  Rank.Five,
  Rank.Six,
  Rank.Seven,
  Rank.Eight,
  Rank.Nine,
  Rank.Ten,
  Rank.Jack,
  Rank.Queen,
  Rank.King,
  Rank.Ace,
];

const RANK_TO_CHAR: Readonly<Record<Rank, string>> = {
  [Rank.Two]: '2',
  [Rank.Three]: '3',
  [Rank.Four]: '4',
  [Rank.Five]: '5',
  [Rank.Six]: '6',
  [Rank.Seven]: '7',
  [Rank.Eight]: '8',
  [Rank.Nine]: '9',
  [Rank.Ten]: 'T',
  [Rank.Jack]: 'J',
  [Rank.Queen]: 'Q',
  [Rank.King]: 'K',
  [Rank.Ace]: 'A',
};

const CHAR_TO_RANK: Readonly<Record<string, Rank>> = Object.fromEntries(
  Object.entries(RANK_TO_CHAR).map(([rank, char]) => [char, Number(rank) as Rank]),
);

const RANK_SINGULAR: Readonly<Record<Rank, string>> = {
  [Rank.Two]: 'Two',
  [Rank.Three]: 'Three',
  [Rank.Four]: 'Four',
  [Rank.Five]: 'Five',
  [Rank.Six]: 'Six',
  [Rank.Seven]: 'Seven',
  [Rank.Eight]: 'Eight',
  [Rank.Nine]: 'Nine',
  [Rank.Ten]: 'Ten',
  [Rank.Jack]: 'Jack',
  [Rank.Queen]: 'Queen',
  [Rank.King]: 'King',
  [Rank.Ace]: 'Ace',
};

const RANK_PLURAL: Readonly<Record<Rank, string>> = {
  [Rank.Two]: 'Twos',
  [Rank.Three]: 'Threes',
  [Rank.Four]: 'Fours',
  [Rank.Five]: 'Fives',
  [Rank.Six]: 'Sixes',
  [Rank.Seven]: 'Sevens',
  [Rank.Eight]: 'Eights',
  [Rank.Nine]: 'Nines',
  [Rank.Ten]: 'Tens',
  [Rank.Jack]: 'Jacks',
  [Rank.Queen]: 'Queens',
  [Rank.King]: 'Kings',
  [Rank.Ace]: 'Aces',
};

export function rankToChar(rank: Rank): string {
  return RANK_TO_CHAR[rank];
}

export function charToRank(char: string): Rank {
  const rank = CHAR_TO_RANK[char.toUpperCase()];
  if (rank === undefined) {
    throw new Error(`Invalid rank character: ${JSON.stringify(char)}`);
  }
  return rank;
}

export function isRank(value: number): value is Rank {
  return Number.isInteger(value) && value >= Rank.Two && value <= Rank.Ace;
}

/** "King" / "Kings" - for hand descriptions. */
export function rankName(rank: Rank, plural = false): string {
  return plural ? RANK_PLURAL[rank] : RANK_SINGULAR[rank];
}
