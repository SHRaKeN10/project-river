import { planBalance, type TournamentTable } from './table-balancing';

/** "abc..." -> a 9-seat table where the first N seats are those players. */
const table = (id: string, players: string, seats = 9): TournamentTable => ({
  id,
  seats: Array.from({ length: seats }, (_, i) => players[i] ?? null),
});

/** Apply a plan and return the resulting seat counts per surviving table id. */
function apply(tables: TournamentTable[], seatsPerTable: number): Record<string, number> {
  const plan = planBalance(tables, seatsPerTable);
  const seats = new Map(tables.map((t) => [t.id, [...t.seats]]));
  for (const m of plan.moves) {
    const from = seats.get(m.from.tableId)!;
    const to = seats.get(m.to.tableId)!;
    expect(from[m.from.seat]).toBe(m.playerId);
    expect(to[m.to.seat]).toBeNull();
    from[m.from.seat] = null;
    to[m.to.seat] = m.playerId;
  }
  const counts: Record<string, number> = {};
  for (const [id, s] of seats) {
    if (plan.breakTableIds.includes(id)) {
      expect(s.every((x) => x === null)).toBe(true);
      continue;
    }
    counts[id] = s.filter((x) => x !== null).length;
  }
  // every player still seated exactly once
  const all = [...seats.values()].flat().filter((x): x is string => x !== null);
  expect(new Set(all).size).toBe(all.length);
  return counts;
}

describe('planBalance', () => {
  it('does nothing when the tables are within one player and a break would not fit', () => {
    // 9 + 8 = 17 players cannot fit on a single nine-handed table
    const plan = planBalance([table('a', 'ABCDEFGHI'), table('b', 'JKLMNOPQ')], 9);
    expect(plan.moves).toEqual([]);
    expect(plan.breakTableIds).toEqual([]);
  });

  it('consolidates to the final table once the field fits on one', () => {
    const counts = apply([table('a', 'PQRST'), table('b', 'UVWX')], 9);
    expect(Object.values(counts)).toEqual([9]);
  });

  it('breaks a table when the field fits on the rest, and levels the survivors', () => {
    const counts = apply([table('a', 'ABCDEF'), table('b', 'GHIJKL'), table('c', 'MNOPQR')], 9);
    // 18 players over 3 nine-handed tables collapse to two of nine
    expect(Object.values(counts).sort()).toEqual([9, 9]);
    expect(Object.keys(counts)).toHaveLength(2);
  });

  it('collapses to a single table once the field is short enough', () => {
    const plan = planBalance([table('a', 'ABCD'), table('b', 'EF')], 9);
    expect(plan.breakTableIds).toHaveLength(1);
    const counts = apply([table('a', 'ABCD'), table('b', 'EF')], 9);
    expect(Object.values(counts)).toEqual([6]);
  });

  it('evens out without breaking when a break would not fit', () => {
    const counts = apply([table('a', 'ABCDEFGHI'), table('b', 'JK')], 9);
    // 11 players, cannot fit on one table -> move until within one
    expect(Object.values(counts).sort((x, y) => x - y)).toEqual([5, 6]);
  });

  it('leaves a 7/7/6 spread alone (no break fits, spread already <= 1)', () => {
    const plan = planBalance(
      [table('a', 'ABCDEFG'), table('b', 'HIJKLMN'), table('c', 'OPQRST')],
      9,
    );
    expect(plan.moves).toEqual([]);
    expect(plan.breakTableIds).toEqual([]);
  });

  it('moves a whole run of players off the biggest table when needed', () => {
    const counts = apply([table('a', 'ABCDEFGHI'), table('b', 'JKLMN'), table('c', 'OP')], 9);
    // 16 players over 3 tables -> as level as possible, spread <= 1
    const values = Object.values(counts).sort((x, y) => x - y);
    expect(values[values.length - 1]! - values[0]!).toBeLessThanOrEqual(1);
    expect(values.reduce((a, b) => a + b, 0)).toBe(16);
  });

  it('six-max: breaks correctly for the smaller table size', () => {
    const counts = apply([table('a', 'ABCD', 6), table('b', 'EFGH', 6), table('c', 'IJ', 6)], 6);
    // 10 players, 6-max -> two tables of 5
    expect(Object.values(counts).sort()).toEqual([5, 5]);
  });
});
