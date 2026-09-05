import { GameVariant } from '../variant/variant';
import { standardBlindSchedule } from './blind-schedule';
import {
  prizePool,
  registrationOpen,
  type TournamentConfig,
  totalTournamentChips,
  validateTournamentConfig,
} from './tournament';

const config = (over: Partial<TournamentConfig> = {}): TournamentConfig => ({
  variant: GameVariant.Holdem,
  buyIn: 1000,
  entryFee: 100,
  startingStack: 20_000,
  seatsPerTable: 9,
  blinds: standardBlindSchedule({ startingBigBlind: 100, levelDurationMs: 600_000, levels: 20 }),
  lateRegUntilLevel: 6,
  maxEntrants: null,
  ...over,
});

describe('validateTournamentConfig', () => {
  it('accepts a sensible config', () => {
    expect(() => validateTournamentConfig(config())).not.toThrow();
  });

  it('rejects bad money and stacks', () => {
    expect(() => validateTournamentConfig(config({ buyIn: 0 }))).toThrow();
    expect(() => validateTournamentConfig(config({ entryFee: -1 }))).toThrow();
    expect(() => validateTournamentConfig(config({ startingStack: 0 }))).toThrow();
  });

  it('caps seats per table by the variant (Big O fits eight)', () => {
    expect(() =>
      validateTournamentConfig(config({ variant: GameVariant.Omaha5HiLo, seatsPerTable: 9 })),
    ).toThrow(/seatsPerTable/);
    expect(() =>
      validateTournamentConfig(config({ variant: GameVariant.Omaha5HiLo, seatsPerTable: 8 })),
    ).not.toThrow();
  });

  it('rejects a late-reg level past the schedule', () => {
    expect(() => validateTournamentConfig(config({ lateRegUntilLevel: 999 }))).toThrow();
  });
});

describe('prizePool / totalTournamentChips', () => {
  it('pool is every buy-in, chips are every starting stack', () => {
    expect(prizePool(config(), 40)).toBe(40_000);
    expect(totalTournamentChips(config(), 40)).toBe(800_000);
  });
});

describe('registrationOpen', () => {
  it('is open before the late-reg level and closed from it on', () => {
    expect(registrationOpen(config({ lateRegUntilLevel: 6 }), 5, 30)).toBe(true);
    expect(registrationOpen(config({ lateRegUntilLevel: 6 }), 6, 30)).toBe(false);
    expect(registrationOpen(config({ lateRegUntilLevel: 6 }), 7, 30)).toBe(false);
  });

  it('closes once the entrant cap is reached', () => {
    expect(registrationOpen(config({ maxEntrants: 30 }), 1, 30)).toBe(false);
    expect(registrationOpen(config({ maxEntrants: 30 }), 1, 29)).toBe(true);
  });
});
