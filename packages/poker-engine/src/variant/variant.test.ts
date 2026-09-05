import { cardsNeeded, GameVariant, isGameVariant, rulesFor } from './variant';

describe('rulesFor', () => {
  it('describes Hold’em', () => {
    expect(rulesFor(GameVariant.Holdem)).toEqual({
      variant: GameVariant.Holdem,
      holeCards: 2,
      holeCardsUsed: null,
      bettingLimit: 'NO_LIMIT',
    });
  });

  it('describes four-card Pot-Limit Omaha', () => {
    expect(rulesFor(GameVariant.Omaha)).toEqual({
      variant: GameVariant.Omaha,
      holeCards: 4,
      holeCardsUsed: 2,
      bettingLimit: 'POT_LIMIT',
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
  });
  it('rejects anything else', () => {
    expect(isGameVariant('PLO5')).toBe(false);
    expect(isGameVariant(undefined)).toBe(false);
    expect(isGameVariant(4)).toBe(false);
  });
});

describe('cardsNeeded', () => {
  it('four-card Omaha fits a full nine-handed table', () => {
    expect(cardsNeeded(rulesFor(GameVariant.Omaha), 9)).toBe(44);
    expect(cardsNeeded(rulesFor(GameVariant.Omaha), 9)).toBeLessThanOrEqual(52);
  });

  it('Hold’em nine-handed', () => {
    expect(cardsNeeded(rulesFor(GameVariant.Holdem), 9)).toBe(26);
  });
});
