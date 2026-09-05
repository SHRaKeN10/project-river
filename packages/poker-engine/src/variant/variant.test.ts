import { cardsNeeded, GameVariant, isGameVariant, maxSeatsForVariant, rulesFor } from './variant';

describe('rulesFor', () => {
  it('describes Hold’em', () => {
    expect(rulesFor(GameVariant.Holdem)).toEqual({
      variant: GameVariant.Holdem,
      holeCards: 2,
      holeCardsUsed: null,
      bettingLimit: 'NO_LIMIT',
      hiLo: false,
      lowQualifier: null,
    });
  });

  it('describes four-card Pot-Limit Omaha', () => {
    expect(rulesFor(GameVariant.Omaha)).toEqual({
      variant: GameVariant.Omaha,
      holeCards: 4,
      holeCardsUsed: 2,
      bettingLimit: 'POT_LIMIT',
      hiLo: false,
      lowQualifier: null,
    });
  });

  it('describes five-card Omaha hi/lo ("Big O")', () => {
    expect(rulesFor(GameVariant.Omaha5HiLo)).toEqual({
      variant: GameVariant.Omaha5HiLo,
      holeCards: 5,
      holeCardsUsed: 2,
      bettingLimit: 'POT_LIMIT',
      hiLo: true,
      lowQualifier: 8,
    });
  });

  it('throws on an unknown variant', () => {
    expect(() => rulesFor('BADUGI' as GameVariant)).toThrow(/unknown game variant/);
  });
});

describe('isGameVariant', () => {
  it('accepts the known variants', () => {
    expect(isGameVariant('HOLDEM')).toBe(true);
    expect(isGameVariant('OMAHA')).toBe(true);
    expect(isGameVariant('OMAHA5_HILO')).toBe(true);
  });
  it('rejects anything else', () => {
    expect(isGameVariant('PLO5')).toBe(false);
    expect(isGameVariant(undefined)).toBe(false);
    expect(isGameVariant(4)).toBe(false);
  });
});

describe('cardsNeeded / maxSeatsForVariant', () => {
  it('four-card Omaha fits a full nine-handed table', () => {
    expect(cardsNeeded(rulesFor(GameVariant.Omaha), 9)).toBe(44);
    expect(maxSeatsForVariant(GameVariant.Omaha)).toBe(9);
  });

  it('Hold’em nine-handed', () => {
    expect(cardsNeeded(rulesFor(GameVariant.Holdem), 9)).toBe(26);
    expect(maxSeatsForVariant(GameVariant.Holdem)).toBe(9);
  });

  it('five-card Omaha only fits eight-handed', () => {
    expect(cardsNeeded(rulesFor(GameVariant.Omaha5HiLo), 9)).toBe(53); // over 52
    expect(cardsNeeded(rulesFor(GameVariant.Omaha5HiLo), 8)).toBe(48);
    expect(maxSeatsForVariant(GameVariant.Omaha5HiLo)).toBe(8);
  });
});
