import { GameVariant } from '@river/poker-engine';
import { variantForGameType } from './game-variant';

describe('variantForGameType', () => {
  it('maps NLHE to Hold’em', () => {
    expect(variantForGameType('NLHE')).toBe(GameVariant.Holdem);
  });

  it('maps PLO to Omaha', () => {
    expect(variantForGameType('PLO')).toBe(GameVariant.Omaha);
  });

  it('maps OMAHA5_HILO to five-card Omaha hi/lo', () => {
    expect(variantForGameType('OMAHA5_HILO')).toBe(GameVariant.Omaha5HiLo);
  });

  it('falls back to Hold’em for anything unknown', () => {
    expect(variantForGameType('BADUGI')).toBe(GameVariant.Holdem);
    expect(variantForGameType('')).toBe(GameVariant.Holdem);
  });
});
