import { type Card } from '../cards/card';
import { createDeck, type DeckState } from '../deck/deck';
import { type RandomProvider } from '../rng/random-provider';

/**
 * Fisher-Yates shuffle. Pure: returns a new array, never mutates the input.
 * Draw index i uniformly from [0, i] using the injected RandomProvider - the
 * only source of randomness in the engine. An unbiased `nextInt` (see
 * RandomProvider) makes this an unbiased permutation.
 */
export function shuffle<T>(items: readonly T[], rng: RandomProvider): T[] {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = rng.nextInt(i + 1);
    const a = result[i] as T;
    const b = result[j] as T;
    result[i] = b;
    result[j] = a;
  }
  return result;
}

/** A freshly shuffled 52-card deck ready to deal. */
export function shuffledDeck(rng: RandomProvider): DeckState {
  const cards: Card[] = shuffle(createDeck(), rng);
  return { cards, cursor: 0 };
}
