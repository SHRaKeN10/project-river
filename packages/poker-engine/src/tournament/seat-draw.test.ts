import { SeededRandomProvider } from '../rng/random-provider';
import { seatDraw } from './seat-draw';

const players = (n: number): string[] => Array.from({ length: n }, (_, i) => `p${i}`);

describe('seatDraw', () => {
  it('splits the field into ceil(n / seatsPerTable) tables, sizes within one', () => {
    for (const [n, per] of [
      [2, 9],
      [10, 9],
      [18, 9],
      [19, 9],
      [100, 9],
      [12, 6],
    ] as const) {
      const tables = seatDraw(players(n), per, new SeededRandomProvider(n));
      expect(tables).toHaveLength(Math.ceil(n / per));
      const sizes = tables.map((t) => t.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
      // everyone seated exactly once
      const seated = tables.flat();
      expect(seated.sort()).toEqual(players(n).sort());
    }
  });

  it('is deterministic for a given seed', () => {
    const a = seatDraw(players(23), 9, new SeededRandomProvider(7));
    const b = seatDraw(players(23), 9, new SeededRandomProvider(7));
    expect(a).toEqual(b);
  });

  it('actually shuffles', () => {
    const inOrder = players(18);
    const drawn = seatDraw(inOrder, 9, new SeededRandomProvider(42));
    expect(drawn.flat()).not.toEqual(inOrder); // vanishingly unlikely to match
  });

  it('rejects malformed input', () => {
    expect(() => seatDraw(players(1), 9, new SeededRandomProvider(1))).toThrow();
    expect(() => seatDraw(players(9), 1, new SeededRandomProvider(1))).toThrow();
    expect(() => seatDraw(['a', 'a'], 9, new SeededRandomProvider(1))).toThrow(/duplicate/);
  });
});
