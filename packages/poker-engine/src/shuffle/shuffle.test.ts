import fc from 'fast-check';
import { allDistinct, cardId } from '../cards/card';
import { createDeck } from '../deck/deck';
import { CryptoRandomProvider, SeededRandomProvider } from '../rng/random-provider';
import { shuffle, shuffledDeck } from './shuffle';

describe('shuffle', () => {
  it('returns a permutation of the input (same multiset, all 52, distinct)', () => {
    const original = createDeck();
    const shuffled = shuffle(original, new SeededRandomProvider(42));
    expect(shuffled).toHaveLength(52);
    expect(allDistinct(shuffled)).toBe(true);
    expect(new Set(shuffled.map(cardId))).toEqual(new Set(original.map(cardId)));
  });

  it('does not mutate the input array', () => {
    const original = createDeck();
    const snapshot = original.map(cardId);
    shuffle(original, new SeededRandomProvider(1));
    expect(original.map(cardId)).toEqual(snapshot);
  });

  it('is deterministic for a given seed', () => {
    const a = shuffle(createDeck(), new SeededRandomProvider(777));
    const b = shuffle(createDeck(), new SeededRandomProvider(777));
    expect(a.map(cardId)).toEqual(b.map(cardId));
  });

  it('produces different orders for different seeds', () => {
    const a = shuffle(createDeck(), new SeededRandomProvider(1));
    const b = shuffle(createDeck(), new SeededRandomProvider(2));
    expect(a.map(cardId)).not.toEqual(b.map(cardId));
  });

  it('actually reorders (not the identity permutation)', () => {
    const original = createDeck().map(cardId);
    const shuffled = shuffle(createDeck(), new SeededRandomProvider(9)).map(cardId);
    const movedPositions = shuffled.filter((id, i) => id !== original[i]).length;
    expect(movedPositions).toBeGreaterThan(40);
  });

  it('shuffledDeck yields a ready-to-deal 52-card deck', () => {
    const deck = shuffledDeck(new CryptoRandomProvider());
    expect(deck.cursor).toBe(0);
    expect(deck.cards).toHaveLength(52);
    expect(allDistinct(deck.cards)).toBe(true);
  });

  it('is unbiased: all 6 permutations of 3 items appear ~evenly (crypto RNG)', () => {
    const rng = new CryptoRandomProvider();
    const counts = new Map<string, number>();
    const trials = 60_000;
    for (let i = 0; i < trials; i += 1) {
      const key = shuffle([0, 1, 2], rng).join('');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(6);
    const expected = trials / 6;
    for (const count of counts.values()) {
      // generous ±12% tolerance - this is a smoke test for gross bias
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.12);
    }
  });

  it('property: shuffled deck is always a permutation of a fresh deck', () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const shuffled = shuffle(createDeck(), new SeededRandomProvider(seed));
        expect(new Set(shuffled.map(cardId))).toEqual(new Set(createDeck().map(cardId)));
      }),
    );
  });
});
