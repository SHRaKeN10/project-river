import { type RandomProvider } from '../rng/random-provider';
import { shuffle } from '../shuffle/shuffle';

/**
 * The opening seat draw: assigns every player to a table as evenly as possible
 * (table sizes differ by at most one), in a randomised order.
 *
 * Returns one array per table; the position of a player id in its array is
 * their seat number (0-indexed, densely filled). The number of tables is
 * `ceil(players / seatsPerTable)`.
 */
export function seatDraw(
  playerIds: readonly string[],
  seatsPerTable: number,
  rng: RandomProvider,
): string[][] {
  if (!Number.isInteger(seatsPerTable) || seatsPerTable < 2) {
    throw new Error(`seatsPerTable must be an integer >= 2, got ${seatsPerTable}`);
  }
  if (playerIds.length < 2) throw new Error('a tournament needs at least two players');
  if (new Set(playerIds).size !== playerIds.length) {
    throw new Error('duplicate player id in the seat draw');
  }

  const tableCount = Math.ceil(playerIds.length / seatsPerTable);
  const tables: string[][] = Array.from({ length: tableCount }, () => []);
  shuffle(playerIds, rng).forEach((id, i) => {
    (tables[i % tableCount] as string[]).push(id);
  });
  return tables;
}
