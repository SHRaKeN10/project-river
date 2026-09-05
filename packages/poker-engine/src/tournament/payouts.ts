/**
 * Tournament prize distribution. Two decisions:
 *   1. how many places cash (`placesPaid`)
 *   2. how the prize pool splits between them (`payoutSchedule`)
 *
 * The percentages below match the shape of a typical card-room MTT structure -
 * roughly the top eighth of the field, a top-heavy curve. They are easy to
 * retune; what matters is that `payoutSchedule` always distributes the pool
 * *exactly* (no chip created or lost), never increasing down the ladder, and
 * with every paid place getting at least one chip.
 */

/** Number of places that cash for a field of `entrants`. */
export function placesPaid(entrants: number): number {
  if (entrants < 2) throw new Error('a tournament needs at least two entrants');
  const byFormula = Math.max(1, Math.ceil(entrants * 0.12));
  // Never pay more than half the field (matters only for tiny fields).
  return Math.min(byFormula, Math.max(1, Math.floor(entrants / 2)));
}

/** Integer percentage splits summing to 100, for small numbers of paid places. */
const PERCENT_TABLE: Readonly<Record<number, readonly number[]>> = {
  1: [100],
  2: [65, 35],
  3: [50, 30, 20],
  4: [40, 26, 20, 14],
  5: [36, 24, 18, 13, 9],
  6: [33, 22, 16, 12, 10, 7],
  7: [31, 21, 15, 12, 9, 7, 5],
  8: [30, 20, 14, 11, 9, 7, 5, 4],
  9: [28, 19, 14, 10, 9, 7, 6, 4, 3],
};

/** Relative weights per place; geometric decay beyond the hand-tuned table. */
function weights(places: number): number[] {
  const table = PERCENT_TABLE[places];
  if (table) return [...table];
  const w: number[] = [];
  for (let k = 0; k < places; k += 1) w.push(0.72 ** k);
  return w;
}

/**
 * The chip amount for each cashing place (index 0 = 1st). Sums to exactly
 * `prizePool`. Every place is guaranteed at least one chip: one chip per place
 * is reserved, then the rest is shared by the curve using the largest-remainder
 * method (rounding chips go to the largest fractional parts, ties to the higher
 * finish). Because the weights strictly decrease, the ladder never increases.
 */
export function payoutSchedule(entrants: number, prizePool: number): number[] {
  if (!Number.isInteger(prizePool) || prizePool <= 0) {
    throw new Error(`prizePool must be a positive integer, got ${prizePool}`);
  }
  const places = placesPaid(entrants);
  if (prizePool < places) {
    throw new Error(`prize pool ${prizePool} cannot pay ${places} places at least one chip each`);
  }

  const distributable = prizePool - places; // one chip per place is reserved
  const w = weights(places);
  const total = w.reduce((s, x) => s + x, 0);
  const exact = w.map((x) => (x / total) * distributable);
  const floors = exact.map(Math.floor);
  let remainder = distributable - floors.reduce((s, x) => s + x, 0);

  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const result = floors.map((f) => f + 1); // add back the reserved chip
  for (const { i } of order) {
    if (remainder <= 0) break;
    result[i] = (result[i] as number) + 1;
    remainder -= 1;
  }
  return result;
}
