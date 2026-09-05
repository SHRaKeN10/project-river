import { type Card } from '../cards/card';

/**
 * The poker variants the engine can deal and settle.
 *
 * `HOLDEM` is the historical default - every table created before variants
 * existed is Hold'em, and `createTableConfig` still defaults to it.
 *
 * `OMAHA` is four-card Pot-Limit Omaha, high only. Five-card Omaha hi/lo
 * ("Big O") lands with the hi/lo split-pot work and is not in this enum yet.
 */
export enum GameVariant {
  Holdem = 'HOLDEM',
  Omaha = 'OMAHA',
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
}

const RULES: Readonly<Record<GameVariant, VariantRules>> = {
  [GameVariant.Holdem]: {
    variant: GameVariant.Holdem,
    holeCards: 2,
    holeCardsUsed: null,
    bettingLimit: 'NO_LIMIT',
  },
  [GameVariant.Omaha]: {
    variant: GameVariant.Omaha,
    holeCards: 4,
    holeCardsUsed: 2,
    bettingLimit: 'POT_LIMIT',
  },
};

export function rulesFor(variant: GameVariant): VariantRules {
  const rules = RULES[variant];
  if (!rules) throw new Error(`unknown game variant: ${String(variant)}`);
  return rules;
}

export function isGameVariant(value: unknown): value is GameVariant {
  return value === GameVariant.Holdem || value === GameVariant.Omaha;
}

/**
 * Every card that leaves the deck during one hand: hole cards for every seat,
 * one burn per community street, and the five board cards. Used to sanity-check
 * that a variant fits in 52 cards at a given seat count (four-card Omaha is
 * fine to nine-handed; five-card would not be).
 */
export function cardsNeeded(rules: VariantRules, seatedPlayers: number): number {
  return rules.holeCards * seatedPlayers + 3 /* burns */ + 5; /* board */
}

/** A hole-card hand, kept as its own type so evaluator signatures read clearly. */
export type HoleCards = readonly Card[];
