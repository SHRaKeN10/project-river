import { Hand } from 'pokersolver';
import { type Card, cardToString } from '../cards';
import { createDeck } from '../deck/deck';
import { SeededRandomProvider } from '../rng/random-provider';
import { shuffle } from '../shuffle/shuffle';
import { compareHandRanks } from './hand-rank';
import { evaluate } from './evaluate';

/**
 * Cross-checks our evaluator against `pokersolver` - an independent, widely-used
 * MIT-licensed implementation - over tens of thousands of random hands. Any
 * disagreement on the ordering of two 7-card hands fails the suite.
 *
 * pokersolver is a devDependency and a test-only oracle; engine source never
 * imports it.
 */

function oracleCompare(a: Card[], b: Card[]): number {
  const handA = Hand.solve(a.map(cardToString));
  const handB = Hand.solve(b.map(cardToString));
  const winners = Hand.winners([handA, handB]);
  const aWon = winners.includes(handA);
  const bWon = winners.includes(handB);
  if (aWon && bWon) return 0;
  return aWon ? 1 : -1;
}

describe('hand-evaluator vs pokersolver oracle', () => {
  it('agrees on the ordering of 25,000 random 7-card hand pairs', () => {
    const rng = new SeededRandomProvider(20260901);
    const pairs = 25_000;
    let mismatches = 0;
    const examples: string[] = [];

    for (let i = 0; i < pairs; i += 1) {
      const shuffled = shuffle(createDeck(), rng);
      const a = shuffled.slice(0, 7);
      const b = shuffled.slice(7, 14);

      const ours = Math.sign(compareHandRanks(evaluate(a), evaluate(b)));
      const theirs = oracleCompare(a, b);

      if (ours !== theirs) {
        mismatches += 1;
        if (examples.length < 5) {
          examples.push(
            `a=[${a.map(cardToString).join(' ')}] b=[${b.map(cardToString).join(' ')}] ours=${ours} oracle=${theirs}`,
          );
        }
      }
    }

    if (mismatches > 0) {
      // eslint-disable-next-line no-console
      console.error('oracle mismatches:\n' + examples.join('\n'));
    }
    expect(mismatches).toBe(0);
  });

  it('agrees on category naming for one hand of each type', () => {
    const cases: Array<[string[], RegExp]> = [
      [['As', 'Ks', 'Qs', 'Js', 'Ts'], /Royal Flush|Straight Flush/i],
      [['9h', '9d', '9c', '9s', 'Kd'], /Four of a Kind/i],
      [['Kh', 'Kd', 'Kc', '3s', '3d'], /Full House/i],
      [['Ah', 'Jh', '9h', '5h', '2h'], /Flush/i],
      [['9c', '8d', '7h', '6s', '5c'], /Straight/i],
      [['Qh', 'Qd', 'Qc', '9s', '4d'], /Three of a Kind/i],
      [['Ah', 'Ad', 'Kh', 'Kd', '3c'], /Two Pair/i],
      [['Th', 'Td', '8c', '5s', '2h'], /Pair/i],
    ];
    for (const [cards, namePattern] of cases) {
      expect(Hand.solve(cards).name).toMatch(namePattern);
    }
  });
});
