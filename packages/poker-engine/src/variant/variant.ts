import { type Card } from '../cards/card';

/**
 * The poker variants the engine can deal and settle.
 *
 * `HOLDEM` is the historical default - every table created before variants
 * existed is Hold'em, and `createTableConfig` still defaults to it.
 *
 * `OMAHA` is four-card Pot-Limit Omaha, high only. `OMAHA5_HILO` ("Big O") is
 * five-card Pot-Limit Omaha, eight-or-better hi/lo split.
 */
export enum GameVariant {
  Holdem = 'HOLDEM',
  Omaha = 'OMAHA',
  Omaha5HiLo = 'OMAHA5_HILO',
}

export type BettingLimit = 'NO_LIMIT' | 'POT_LIMIT';

/**
 * The rule differences between variants, resolved once from the variant and
 * then read wherever dealing, hand evaluation, or bet sizing needs to branch.
 */
export interface VariantRules {
  readonly variant: GameVariant;
  /** Hole cards dealt to each player at the start of the hand. */
  readonly holeCards: number;
  /**
   * How many of a player's hole cards a made hand must use.
   *  - `null`: any number - Hold'em, where "playing the board" is legal.
   *  - `2`: exactly two - the Omaha family.
   */
  readonly holeCardsUsed: number | null;
  readonly bettingLimit: BettingLimit;
  /**
   * Split-pot: the pot is shared between the best high hand and the best
   * qualifying low hand (the high hand takes it all when no low qualifies).
   */
  readonly hiLo: boolean;
  /**
   * Highest card rank (ace = 1) a low hand may contain and still qualify, or
   * `null` when `hiLo` is false. 8 means "eight or better".
   */
  readonly lowQualifier: number | null;
}

const RULES: Readonly<Record<GameVariant, VariantRules>> = {
  [GameVariant.Holdem]: {
    variant: GameVariant.Holdem,
    holeCards: 2,
    holeCardsUsed: null,
    bettingLimit: 'NO_LIMIT',
    hiLo: false,
    lowQualifier: null,
  },
  [GameVariant.Omaha]: {
    variant: GameVariant.Omaha,
    holeCards: 4,
    holeCardsUsed: 2,
    bettingLimit: 'POT_LIMIT',
    hiLo: false,
    lowQualifier: null,
  },
  [GameVariant.Omaha5HiLo]: {
    variant: GameVariant.Omaha5HiLo,
    holeCards: 5,
    holeCardsUsed: 2,
    bettingLimit: 'POT_LIMIT',
    hiLo: true,
    lowQualifier: 8,
  },
};

export function rulesFor(variant: GameVariant): VariantRules {
  const rules = RULES[variant];
  if (!rules) throw new Error(`unknown game variant: ${String(variant)}`);
  return rules;
}

export function isGameVariant(value: unknown): value is GameVariant {
  return (
    value === GameVariant.Holdem || value === GameVariant.Omaha || value === GameVariant.Omaha5HiLo
  );
}

/**
 * Every card that leaves the deck during one hand: hole cards for every seat,
 * one burn per community street, and the five board cards.
 */
export function cardsNeeded(rules: VariantRules, seatedPlayers: number): number {
  return rules.holeCards * seatedPlayers + 3 /* burns */ + 5; /* board */
}

/**
 * The most seats a variant can be dealt from one 52-card deck (also capped at
 * the table maximum of 9). Five-card Omaha only fits eight-handed.
 */
export function maxSeatsForVariant(variant: GameVariant): number {
  const perDeal = rulesFor(variant).holeCards;
  return Math.min(9, Math.floor((52 - 3 - 5) / perDeal));
}

/** A hole-card hand, kept as its own type so evaluator signatures read clearly. */
export type HoleCards = readonly Card[];
