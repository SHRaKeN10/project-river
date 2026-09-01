import fc from 'fast-check';
import { allDistinct, cardId } from '../cards/card';
import {
  burnCard,
  createDeck,
  dealCard,
  dealCards,
  DECK_SIZE,
  DeckExhaustedError,
  deckFromCards,
  freshDeck,
  remainingCards,
  remainingCount,
  resetDeck,
} from './deck';

describe('deck', () => {
  it('freshDeck starts with 52 undealt cards', () => {
    const deck = freshDeck();
    expect(deck.cursor).toBe(0);
    expect(remainingCount(deck)).toBe(DECK_SIZE);
    expect(allDistinct(deck.cards)).toBe(true);
  });

  it('deals cards off the top in order, without mutating the source', () => {
    const deck = freshDeck();
    const { cards, deck: after } = dealCards(deck, 5);

    expect(cards).toHaveLength(5);
    expect(cards).toEqual(deck.cards.slice(0, 5));
    expect(remainingCount(after)).toBe(47);
    expect(remainingCount(deck)).toBe(52); // original untouched
  });

  it('dealCard returns one card and advances by one', () => {
    const { card, deck } = dealCard(freshDeck());
    expect(deck.cursor).toBe(1);
    expect(card).toEqual(freshDeck().cards[0]);
  });

  it('continues dealing from where it left off', () => {
    let deck = freshDeck();
    const seen = new Set<number>();
    for (let i = 0; i < DECK_SIZE; i += 1) {
      const dealt = dealCard(deck);
      seen.add(cardId(dealt.card));
      deck = dealt.deck;
    }
    expect(seen.size).toBe(52);
    expect(remainingCount(deck)).toBe(0);
  });

  it('throws when dealing past the end', () => {
    const deck = { cards: createDeck(), cursor: 50 };
    expect(() => dealCards(deck, 3)).toThrow(DeckExhaustedError);
    expect(() => dealCard(dealCards(deck, 2).deck)).toThrow(DeckExhaustedError);
  });

  it('rejects negative / non-integer counts', () => {
    expect(() => dealCards(freshDeck(), -1)).toThrow();
    expect(() => dealCards(freshDeck(), 2.5)).toThrow();
  });

  it('burnCard consumes a card like a deal', () => {
    const start = freshDeck();
    const { deck } = burnCard(start);
    expect(remainingCount(deck)).toBe(51);
  });

  it('resetDeck rewinds without reordering', () => {
    const dealt = dealCards(freshDeck(), 10).deck;
    const reset = resetDeck(dealt);
    expect(reset.cursor).toBe(0);
    expect(reset.cards).toEqual(dealt.cards);
  });

  it('deckFromCards validates size', () => {
    expect(() => deckFromCards(createDeck().slice(0, 51))).toThrow();
    expect(remainingCount(deckFromCards(createDeck()))).toBe(52);
  });

  it('remainingCards reflects what has not been dealt', () => {
    const deck = dealCards(freshDeck(), 12).deck;
    expect(remainingCards(deck)).toHaveLength(40);
    expect(remainingCards(deck)).toEqual(deck.cards.slice(12));
  });

  it('property: every card is dealt exactly once over a full deck', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 13 }), (chunk) => {
        let deck = freshDeck();
        const dealt: number[] = [];
        while (remainingCount(deck) > 0) {
          const n = Math.min(chunk, remainingCount(deck));
          const res = dealCards(deck, n);
          dealt.push(...res.cards.map(cardId));
          deck = res.deck;
        }
        expect(new Set(dealt).size).toBe(52);
      }),
    );
  });
});
