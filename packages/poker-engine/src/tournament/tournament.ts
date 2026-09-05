import { type GameVariant } from '../variant/variant';
import { maxSeatsForVariant } from '../variant/variant';
import { type BlindSchedule, validateBlindSchedule } from './blind-schedule';

/**
 * The fixed terms of a tournament. Play money for now (`buyIn` funds the prize
 * pool, `entryFee` is the house's cut - the tournament equivalent of the cash
 * game's time charge). Chips here are *tournament* chips: they have no cash
 * value and never leave the tournament.
 */
export interface TournamentConfig {
  readonly variant: GameVariant;
  /** Chips added to the prize pool per entry. */
  readonly buyIn: number;
  /** The house's fee per entry; not added to the pool. 0 = freeroll-style. */
  readonly entryFee: number;
  /** Tournament chips every entrant starts with. */
  readonly startingStack: number;
  /** 2..9 (and at most `maxSeatsForVariant(variant)`). */
  readonly seatsPerTable: number;
  readonly blinds: BlindSchedule;
  /** Registration closes when this level begins (1 = no late registration). */
  readonly lateRegUntilLevel: number;
  /** Hard cap on entrants, or `null` for uncapped. */
  readonly maxEntrants: number | null;
}

export function validateTournamentConfig(config: TournamentConfig): void {
  validateBlindSchedule(config.blinds);
  if (config.buyIn <= 0) throw new Error('buyIn must be positive');
  if (config.entryFee < 0) throw new Error('entryFee cannot be negative');
  if (config.startingStack <= 0) throw new Error('startingStack must be positive');
  const cap = maxSeatsForVariant(config.variant);
  if (config.seatsPerTable < 2 || config.seatsPerTable > cap) {
    throw new Error(`seatsPerTable must be between 2 and ${cap} for ${config.variant}`);
  }
  if (config.lateRegUntilLevel < 1 || config.lateRegUntilLevel > config.blinds.length + 1) {
    throw new Error('lateRegUntilLevel out of range');
  }
  if (config.maxEntrants !== null && config.maxEntrants < 2) {
    throw new Error('maxEntrants must be at least 2');
  }
}

/** Total tournament chips in play for a given field. Equals the sum of every
 * stack at all times - the coordinator asserts this as its conservation check. */
export function totalTournamentChips(config: TournamentConfig, entrants: number): number {
  return config.startingStack * entrants;
}

/** The cash prize pool (play chips): every buy-in, no fees. */
export function prizePool(config: TournamentConfig, entrants: number): number {
  return config.buyIn * entrants;
}

/** Whether a new entrant may still register, given the current level. */
export function registrationOpen(
  config: TournamentConfig,
  currentLevel: number,
  entrants: number,
): boolean {
  if (config.maxEntrants !== null && entrants >= config.maxEntrants) return false;
  return currentLevel < config.lateRegUntilLevel;
}
