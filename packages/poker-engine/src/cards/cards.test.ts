import fc from 'fast-check';
import {
  allDistinct,
  cardFromId,
  cardId,
  cardToString,
  makeCard,
  parseCard,
  parseCards,
  Rank,
  RANKS,
  rankName,
  sameCard,
  Suit,
  SUITS,
} from './index';
import { createDeck } from '../deck/deck';

describe('cards', () => {
  describe('deck composition', () => {
    const deck = createDeck();

    it('has 52 cards', () => {
      expect(deck).toHaveLength(52);
    });

    it('has 52 distinct cards', () => {
      expect(allDistinct(deck)).toBe(true);
      expect(new Set(deck.map(cardId)).size).toBe(52);
    });

    it('contains every rank/suit combination exactly once', () => {
      for (const rank of RANKS) {
        for (const suit of SUITS) {
          expect(deck.filter((c) => c.rank === rank && c.suit === suit)).toHaveLength(1);
        }
      }
    });
  });

  describe('cardId <-> card', () => {
    it('is a bijection onto 0..51', () => {
      const ids = createDeck()
        .map(cardId)
        .sort((a, b) => a - b);
      expect(ids).toEqual(Array.from({ length: 52 }, (_, i) => i));
    });

    it('round-trips through cardFromId', () => {
      for (const card of createDeck()) {
        expect(cardFromId(cardId(card))).toEqual(card);
      }
    });

    it('rejects out-of-range ids', () => {
      expect(() => cardFromId(-1)).toThrow();
      expect(() => cardFromId(52)).toThrow();
      expect(() => cardFromId(1.5)).toThrow();
    });
  });

  describe('string form', () => {
    it('formats and parses every card', () => {
      for (const card of createDeck()) {
        expect(parseCard(cardToString(card))).toEqual(card);
      }
    });

    it('accepts common notations', () => {
      expect(parseCard('As')).toEqual(makeCard(Rank.Ace, Suit.Spades));
      expect(parseCard('Td')).toEqual(makeCard(Rank.Ten, Suit.Diamonds));
      expect(parseCard('10d')).toEqual(makeCard(Rank.Ten, Suit.Diamonds));
      expect(parseCard('2C')).toEqual(makeCard(Rank.Two, Suit.Clubs));
      expect(parseCard(' kh ')).toEqual(makeCard(Rank.King, Suit.Hearts));
    });

    it('rejects malformed cards', () => {
      for (const bad of ['', 'A', 'Xs', 'Ax', '1s', 'Ass', '99']) {
        expect(() => parseCard(bad)).toThrow();
      }
    });

    it('parses card lists in several formats', () => {
      const expected = [
        makeCard(Rank.Ace, Suit.Spades),
        makeCard(Rank.King, Suit.Diamonds),
        makeCard(Rank.Queen, Suit.Hearts),
      ];
      expect(parseCards('As Kd Qh')).toEqual(expected);
      expect(parseCards('As,Kd,Qh')).toEqual(expected);
      expect(parseCards('AsKdQh')).toEqual(expected);
      expect(parseCards('')).toEqual([]);
    });
  });

  describe('helpers', () => {
    it('sameCard compares by value', () => {
      expect(sameCard(makeCard(Rank.Ace, Suit.Spades), parseCard('As'))).toBe(true);
      expect(sameCard(makeCard(Rank.Ace, Suit.Spades), parseCard('Ah'))).toBe(false);
    });

    it('allDistinct detects duplicates', () => {
      expect(allDistinct(parseCards('As Kd'))).toBe(true);
      expect(allDistinct(parseCards('As As'))).toBe(false);
    });

    it('rankName gives singular and plural forms', () => {
      expect(rankName(Rank.King)).toBe('King');
      expect(rankName(Rank.King, true)).toBe('Kings');
      expect(rankName(Rank.Six, true)).toBe('Sixes');
    });
  });

  it('property: parse(format(card)) === card for arbitrary cards', () => {
    const arbCard = fc.record({
      rank: fc.constantFrom(...RANKS),
      suit: fc.constantFrom(...SUITS),
    });
    fc.assert(
      fc.property(arbCard, (card) => {
        expect(parseCard(cardToString(card))).toEqual(card);
      }),
    );
  });
});
