import { type Card, cardId, makeCard, parseCards, Rank, Suit } from '../cards';
import { createDeck } from '../deck/deck';
import { SeededRandomProvider } from '../rng/random-provider';
import { shuffle } from '../shuffle/shuffle';
import { compareHandRanks, HandCategory, handCategoryName } from './hand-rank';
import { evaluate } from './evaluate';

/** Deterministic so CI never flakes; the seed just needs to be fixed. */
const rng = new SeededRandomProvider(0x51713);

describe('hand-evaluator: large-scale simulation', () => {
  it('7-card category frequencies land in the known ballpark (100k deals)', () => {
    const deals = 100_000;
    const counts = new Map<HandCategory, number>();
    for (let i = 0; i < deals; i += 1) {
      const seven = shuffle(createDeck(), rng).slice(0, 7);
      const category = evaluate(seven).category;
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }

    const pct = (c: HandCategory) => ((counts.get(c) ?? 0) / deals) * 100;

    // Reference 7-card probabilities, with generous tolerances.
    expect(pct(HandCategory.HighCard)).toBeGreaterThan(13);
    expect(pct(HandCategory.HighCard)).toBeLessThan(22);
    expect(pct(HandCategory.Pair)).toBeGreaterThan(39);
    expect(pct(HandCategory.Pair)).toBeLessThan(49);
    expect(pct(HandCategory.TwoPair)).toBeGreaterThan(19);
    expect(pct(HandCategory.TwoPair)).toBeLessThan(28);
    expect(pct(HandCategory.ThreeOfAKind)).toBeGreaterThan(3);
    expect(pct(HandCategory.ThreeOfAKind)).toBeLessThan(7);
    expect(pct(HandCategory.Straight)).toBeGreaterThan(3);
    expect(pct(HandCategory.Straight)).toBeLessThan(7);
    expect(pct(HandCategory.Flush)).toBeGreaterThan(1.5);
    expect(pct(HandCategory.Flush)).toBeLessThan(4.5);
    expect(pct(HandCategory.FullHouse)).toBeGreaterThan(1.5);
    expect(pct(HandCategory.FullHouse)).toBeLessThan(4);
    expect(pct(HandCategory.FourOfAKind)).toBeLessThan(0.5);
    expect(pct(HandCategory.StraightFlush)).toBeLessThan(0.15);

    // eslint-disable-next-line no-console
    console.log(
      '7-card category mix:',
      [...counts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([c, n]) => `${handCategoryName(c)} ${((n / deals) * 100).toFixed(2)}%`)
        .join(', '),
    );
  });

  it('runs thousands of hands without a single throw or invalid result', () => {
    for (let i = 0; i < 20_000; i += 1) {
      const seven = shuffle(createDeck(), rng).slice(0, 7);
      const result = evaluate(seven);
      expect(result.cards).toHaveLength(5);
      expect(result.category).toBeGreaterThanOrEqual(HandCategory.HighCard);
      expect(result.category).toBeLessThanOrEqual(HandCategory.StraightFlush);
      // the 5 chosen cards must be a subset of the 7 dealt
      const sevenIds = new Set(seven.map(cardId));
      for (const card of result.cards) expect(sevenIds.has(cardId(card))).toBe(true);
    }
  });

  it('pocket Aces beat pocket Kings pre-flop roughly 80% of the time', () => {
    const aces: Card[] = [makeCard(Rank.Ace, Suit.Spades), makeCard(Rank.Ace, Suit.Hearts)];
    const kings: Card[] = [makeCard(Rank.King, Suit.Spades), makeCard(Rank.King, Suit.Hearts)];
    const blocked = new Set([...aces, ...kings].map(cardId));
    const stock = createDeck().filter((c) => !blocked.has(cardId(c)));

    const trials = 20_000;
    let acesWins = 0;
    let splits = 0;
    for (let i = 0; i < trials; i += 1) {
      const board = shuffle(stock, rng).slice(0, 5);
      const diff = compareHandRanks(evaluate([...aces, ...board]), evaluate([...kings, ...board]));
      if (diff > 0) acesWins += 1;
      else if (diff === 0) splits += 1;
    }
    const acesEquity = (acesWins + splits / 2) / trials;
    expect(acesEquity).toBeGreaterThan(0.78);
    expect(acesEquity).toBeLessThan(0.87);
  });

  it('a made straight on the board splits between two players holding blanks', () => {
    const board = parseCards('9h 8s 7d 6c 5h');
    const alice = evaluate([...board, ...parseCards('Ac 2d')]);
    const bob = evaluate([...board, ...parseCards('Kc 3d')]);
    expect(alice.category).toBe(HandCategory.Straight);
    expect(compareHandRanks(alice, bob)).toBe(0);
  });
});
