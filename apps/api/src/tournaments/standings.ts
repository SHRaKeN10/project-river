import {
  bustedTogether,
  type Elimination,
  finishingOrder,
  payoutSchedule,
} from '@river/poker-engine';

/**
 * The pure standings maths for the tournament coordinator: assigning finishing
 * positions to a hand-for-hand round's bust-outs, and splitting the prize pool
 * with exact-tie chops. Kept separate from the coordinator so the tricky
 * cases (ties across the payout boundary, three-way ties, odd chips) can be
 * tested exhaustively without standing a tournament up.
 */

export interface RoundBust {
  playerId: string;
  /** Chips this player had when this round's hand started at their table. */
  stackAtHandStart: number;
}

export interface RoundAssignment {
  /** playerId -> finishing position (distinct, contiguous, descending). */
  positions: Map<string, number>;
  /** Contiguous position ranges whose prize money chops equally this round. */
  chopGroups: number[][];
}

/**
 * Assign finishing positions to one hand-for-hand round's bust-outs.
 *
 * `eliminatedCount` players are already out; this round busts `busts.length`
 * more, filling the next contiguous block of positions counting *down* from
 * `entrants - eliminatedCount` (the worst place still open). The order is
 * fully deterministic - a bigger covered stack finishes higher, exact ties
 * fall to player id (`finishingOrder`) - so which table's hand happened to
 * finish first can never move the standings.
 *
 * When `handForHand` is on and a group of players busted this round with
 * *exactly* equal covered stacks, and that group's best position is a paid
 * place, those positions chop their combined prize money.
 */
export function assignRoundPositions(args: {
  busts: readonly RoundBust[];
  eliminatedCount: number;
  entrants: number;
  roundNumber: number;
  handForHand: boolean;
  paidPlaces: number;
}): RoundAssignment {
  const { busts, eliminatedCount, entrants, roundNumber, handForHand, paidPlaces } = args;

  const elims: Elimination[] = busts.map((b) => ({
    playerId: b.playerId,
    stackAtHandStart: b.stackAtHandStart,
    handNumber: roundNumber,
  }));
  const byId = new Map(elims.map((e) => [e.playerId, e]));
  const order = finishingOrder(elims, []); // best finish first

  const k = order.length;
  const worst = entrants - eliminatedCount;
  const best = worst - k + 1;

  const positions = new Map<string, number>();
  order.forEach((pid, i) => positions.set(pid, best + i));

  const chopGroups: number[][] = [];
  if (handForHand) {
    let groupStart = 0;
    for (let i = 1; i <= k; i += 1) {
      const tiedWithPrev =
        i < k && bustedTogether(byId.get(order[i - 1] as string)!, byId.get(order[i] as string)!);
      if (!tiedWithPrev) {
        const range = order.slice(groupStart, i).map((pid) => positions.get(pid) as number);
        if (range.length > 1 && Math.min(...range) <= paidPlaces) chopGroups.push(range);
        groupStart = i;
      }
    }
  }

  return { positions, chopGroups };
}

/**
 * The prize for every finishing position `1..entrants`. Starts from the payout
 * ladder (`payoutSchedule`); then, for each chopped position range, the
 * members' prizes are replaced by an equal split of their combined money - odd
 * chips going to the better (lower) positions first. The total is never
 * changed, so the sum over every position still equals the prize pool exactly.
 */
export function computePayouts(
  entrants: number,
  prizePool: number,
  chopGroups: readonly (readonly number[])[],
): Map<number, number> {
  const ladder = payoutSchedule(entrants, prizePool); // length = placesPaid
  const out = new Map<number, number>();
  for (let pos = 1; pos <= entrants; pos += 1) {
    out.set(pos, pos <= ladder.length ? (ladder[pos - 1] as number) : 0);
  }

  for (const group of chopGroups) {
    const combined = group.reduce((sum, pos) => sum + (out.get(pos) ?? 0), 0);
    const each = Math.floor(combined / group.length);
    let remainder = combined - each * group.length;
    for (const pos of [...group].sort((a, b) => a - b)) {
      out.set(pos, each + (remainder > 0 ? 1 : 0));
      if (remainder > 0) remainder -= 1;
    }
  }
  return out;
}
