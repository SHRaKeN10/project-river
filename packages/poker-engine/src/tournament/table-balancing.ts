/**
 * Multi-table balancing. Between hands the coordinator asks: given the current
 * seating, does anyone need to move? Two things can happen, in this order:
 *
 *   1. **Break a table** - if the remaining players all fit on the other tables,
 *      the shortest table is dissolved and its players fill the open seats
 *      (emptiest tables first, so the result is balanced). Repeats until no
 *      further table can be broken.
 *   2. **Even out** - otherwise, while the biggest table has two or more players
 *      more than the smallest, one player moves from the biggest to the
 *      smallest.
 *
 * This function decides the *structure* - which player leaves which table for
 * which seat. It picks the mover deterministically (the highest-seat player on
 * the source table); the coordinator, which knows the button, substitutes the
 * player who is about to post the big blind so nobody skips one unfairly. Only
 * safe to apply between hands.
 */
export interface TournamentTable {
  readonly id: string;
  /** Player id per seat, `null` for an empty seat. Length is the tournament's
   * seats-per-table. */
  readonly seats: readonly (string | null)[];
}

export interface SeatRef {
  readonly tableId: string;
  readonly seat: number;
}

export interface BalanceMove {
  readonly playerId: string;
  readonly from: SeatRef;
  readonly to: SeatRef;
}

export interface BalancePlan {
  readonly moves: readonly BalanceMove[];
  /** Tables to dissolve - every remaining player on them appears in `moves`. */
  readonly breakTableIds: readonly string[];
}

interface WorkingTable {
  id: string;
  seats: (string | null)[];
}

const occupied = (t: WorkingTable): number => t.seats.filter((s) => s !== null).length;
const firstEmpty = (t: WorkingTable): number => t.seats.findIndex((s) => s === null);
const highestOccupied = (t: WorkingTable): number => {
  for (let i = t.seats.length - 1; i >= 0; i -= 1) if (t.seats[i] !== null) return i;
  return -1;
};

export function planBalance(
  tables: readonly TournamentTable[],
  seatsPerTable: number,
): BalancePlan {
  const working: WorkingTable[] = tables.map((t) => ({ id: t.id, seats: [...t.seats] }));
  const moves: BalanceMove[] = [];
  const broken: string[] = [];

  const move = (from: WorkingTable, fromSeat: number, to: WorkingTable): void => {
    const playerId = from.seats[fromSeat];
    if (playerId == null) return;
    const toSeat = firstEmpty(to);
    if (toSeat === -1) return;
    from.seats[fromSeat] = null;
    to.seats[toSeat] = playerId;
    moves.push({
      playerId,
      from: { tableId: from.id, seat: fromSeat },
      to: { tableId: to.id, seat: toSeat },
    });
  };

  // --- 1. break tables while possible -------------------------------------
  for (;;) {
    const live = working.filter((t) => occupied(t) > 0);
    if (live.length <= 1) break;
    const players = live.reduce((sum, t) => sum + occupied(t), 0);
    const capacityWithoutOne = (live.length - 1) * seatsPerTable;
    if (players > capacityWithoutOne) break;

    // Break the shortest live table (tie: lowest id, stable).
    const victim = [...live].sort((a, b) => occupied(a) - occupied(b) || cmp(a.id, b.id))[0];
    if (!victim) break;
    const others = live
      .filter((t) => t !== victim)
      .sort((a, b) => occupied(a) - occupied(b) || cmp(a.id, b.id));
    // Deal the victim's players onto the emptiest tables, round robin, so the
    // survivors stay level.
    const leaving = victim.seats.map((s, i) => ({ s, i })).filter((x) => x.s !== null);
    for (const { i } of leaving) {
      others.sort((a, b) => occupied(a) - occupied(b) || cmp(a.id, b.id));
      const dest = others[0];
      if (!dest || firstEmpty(dest) === -1) break;
      move(victim, i, dest);
    }
    broken.push(victim.id);
  }

  // --- 2. even out the rest ---------------------------------------------------
  for (;;) {
    const live = working.filter((t) => occupied(t) > 0 && !broken.includes(t.id));
    if (live.length <= 1) break;
    const sorted = [...live].sort((a, b) => occupied(a) - occupied(b) || cmp(a.id, b.id));
    const smallest = sorted[0] as WorkingTable;
    const biggest = sorted[sorted.length - 1] as WorkingTable;
    if (occupied(biggest) - occupied(smallest) < 2) break;
    if (firstEmpty(smallest) === -1) break;
    move(biggest, highestOccupied(biggest), smallest);
  }

  return { moves, breakTableIds: broken };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
