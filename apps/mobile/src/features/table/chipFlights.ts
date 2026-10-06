import type { TableStateView } from '@river/shared-types';

export interface SeatSnap {
  seat: number;
  bet: number;
  stack: number;
}

export interface TableSnap {
  handId: string | null;
  pot: number;
  seats: SeatSnap[];
}

/** bet: seat -> its bet chip. collect: bet chip -> pot. award: pot -> seat. */
export type FlightKind = 'bet' | 'collect' | 'award';

export interface FlightSpec {
  kind: FlightKind;
  seat: number;
  amount: number;
  /** ms to wait before it leaves, so a collect reads before the award. */
  delay: number;
}

/** Never animate more than this per update (a re-sync after a reconnect can
 * change every seat at once). */
const MAX_FLIGHTS = 12;
const AWARD_DELAY_MS = 500;

export function snapshotOf(view: Pick<TableStateView, 'handId' | 'pot' | 'seats'>): TableSnap {
  return {
    handId: view.handId,
    pot: view.pot,
    seats: view.seats
      .filter((s) => s.userId !== null)
      .map((s) => ({ seat: s.seatNumber, bet: s.currentBet, stack: s.stack })),
  };
}

/**
 * Which chips moved between two table snapshots. Pure, so the animation layer
 * only has to draw what this says:
 * - a seat's bet went up (or a blind was posted for a new hand): chips go from
 *   the seat to its bet spot;
 * - a seat's bet went to zero within the same hand: the street ended and the
 *   chips go from the bet spot to the pot;
 * - a seat's stack went up while there was a pot: the pot pays out to the seat.
 * The first snapshot (just sat down / just connected) animates nothing.
 */
export function diffFlights(prev: TableSnap | null, next: TableSnap): FlightSpec[] {
  if (!prev) return [];
  const sameHand = next.handId !== null && prev.handId === next.handId;
  const out: FlightSpec[] = [];

  for (const now of next.seats) {
    const before = prev.seats.find((s) => s.seat === now.seat);
    if (!before) continue;
    const prevBet = sameHand ? before.bet : 0;

    if (now.bet > prevBet) {
      out.push({ kind: 'bet', seat: now.seat, amount: now.bet - prevBet, delay: 0 });
    } else if (sameHand && before.bet > 0 && now.bet === 0) {
      out.push({ kind: 'collect', seat: now.seat, amount: before.bet, delay: 0 });
    }

    if (now.stack > before.stack && prev.pot > 0) {
      out.push({
        kind: 'award',
        seat: now.seat,
        amount: now.stack - before.stack,
        delay: AWARD_DELAY_MS,
      });
    }
  }
  return out.slice(0, MAX_FLIGHTS);
}
