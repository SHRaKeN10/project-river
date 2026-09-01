import fc from 'fast-check';
import { CryptoRandomProvider, SeededRandomProvider } from './random-provider';

describe('SeededRandomProvider', () => {
  it('is deterministic for a given seed', () => {
    const a = new SeededRandomProvider(12345);
    const b = new SeededRandomProvider(12345);
    const seqA = Array.from({ length: 50 }, () => a.nextInt(52));
    const seqB = Array.from({ length: 50 }, () => b.nextInt(52));
    expect(seqA).toEqual(seqB);
  });

  it('produces different streams for different seeds', () => {
    const a = new SeededRandomProvider(1);
    const b = new SeededRandomProvider(2);
    const seqA = Array.from({ length: 20 }, () => a.nextInt(1000));
    const seqB = Array.from({ length: 20 }, () => b.nextInt(1000));
    expect(seqA).not.toEqual(seqB);
  });

  it('always returns values within [0, maxExclusive)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100000 }), fc.integer(), (max, seed) => {
        const rng = new SeededRandomProvider(seed);
        for (let i = 0; i < 100; i += 1) {
          const v = rng.nextInt(max);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThan(max);
        }
      }),
    );
  });

  it('rejects invalid bounds', () => {
    const rng = new SeededRandomProvider(0);
    expect(() => rng.nextInt(0)).toThrow(RangeError);
    expect(() => rng.nextInt(-5)).toThrow(RangeError);
    expect(() => rng.nextInt(1.5)).toThrow(RangeError);
  });

  it('is roughly uniform over a small range', () => {
    const rng = new SeededRandomProvider(99);
    const counts = new Array(6).fill(0);
    const draws = 60000;
    for (let i = 0; i < draws; i += 1) counts[rng.nextInt(6)] += 1;
    for (const c of counts) {
      expect(c).toBeGreaterThan(draws / 6 - 1000);
      expect(c).toBeLessThan(draws / 6 + 1000);
    }
  });
});

describe('CryptoRandomProvider', () => {
  const rng = new CryptoRandomProvider();

  it('stays within bounds', () => {
    for (let i = 0; i < 1000; i += 1) {
      const v = rng.nextInt(52);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(52);
    }
  });

  it('returns the requested number of bytes', () => {
    expect(rng.bytes(16)).toHaveLength(16);
  });

  it('handles maxExclusive === 1', () => {
    expect(rng.nextInt(1)).toBe(0);
  });
});
