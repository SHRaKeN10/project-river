import type { HandUpdateEvent, TableStateView } from '@river/shared-types';

export interface SeatSlot {
  /** 0..maxSeats-1 */
  index: number;
  /** fraction of table width, 0..1, of the seat centre */
  x: number;
  /** fraction of table height, 0..1 */
  y: number;
}

export const SEAT_POD_MAX_WIDTH = 104;
export const SEAT_POD_MIN_WIDTH = 84;

/** Pod width that fits the felt: full size on roomy screens, shrinking (to a
 * floor) on narrow phones so two pods never overlap the centre. */
export function seatPodWidth(feltWidth: number): number {
  if (!Number.isFinite(feltWidth) || feltWidth <= 0) return SEAT_POD_MAX_WIDTH;
  return Math.round(Math.max(SEAT_POD_MIN_WIDTH, Math.min(SEAT_POD_MAX_WIDTH, feltWidth * 0.34)));
}

/**
 * Positions `count` seats around an oval, hero (the viewer, or seat 0 when
 * spectating) pinned bottom-centre and the rest spread clockwise. Returns the
 * slot for every seat index, already rotated so `heroIndex` sits at the bottom.
 *
 * `feltWidth`/`podWidth` (px) tighten the horizontal spread so a pod's box
 * always stays fully on the felt - without them a narrow screen clips the side
 * seats.
 */
export function seatRing(
  count: number,
  heroIndex: number,
  feltWidth?: number,
  podWidth: number = SEAT_POD_MAX_WIDTH,
): SeatSlot[] {
  // Horizontal margin (as a fraction) that keeps a pod's half-width + a little
  // air inside the felt. Falls back to the old fixed clamp with no width.
  const marginX =
    feltWidth && feltWidth > 0 ? clamp01((podWidth / 2 + 4) / feltWidth, 0.16, 0.4) : 0.16;

  const slots: SeatSlot[] = [];
  for (let i = 0; i < count; i += 1) {
    // rotate so the hero is at angle 90deg (bottom); go clockwise from there
    const offset = (i - heroIndex + count) % count;
    const angle = Math.PI / 2 + (offset / count) * Math.PI * 2;
    slots.push({
      index: i,
      x: clamp01(0.5 + Math.cos(angle) * 0.42, marginX, 1 - marginX),
      y: clamp01(0.5 + Math.sin(angle) * 0.44, 0.08, 0.92),
    });
  }
  return slots;
}

function clamp01(n: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, n));
}

export function isHeroTurn(view: TableStateView): boolean {
  return (
    view.youAreSeat !== null &&
    view.actingSeat === view.youAreSeat &&
    (view.legalActions?.length ?? 0) > 0
  );
}

export function heroSeat(view: TableStateView) {
  return view.youAreSeat === null
    ? null
    : (view.seats.find((s) => s.seatNumber === view.youAreSeat) ?? null);
}

export function occupiedCount(view: TableStateView): number {
  return view.seats.filter((s) => s.userId !== null).length;
}

const STREET_LABEL: Record<string, string> = {
  PREFLOP: 'Pre-flop',
  FLOP: 'Flop',
  TURN: 'Turn',
  RIVER: 'River',
  SHOWDOWN: 'Showdown',
  COMPLETE: 'Hand complete',
  WAITING: 'Waiting for players',
};

export function streetLabel(street: string): string {
  return STREET_LABEL[street] ?? street;
}

/** Turn a stripped `hand:update` event into one short feed line, or null to skip. */
export function describeEvent(
  ev: HandUpdateEvent,
  nameForSeat: (seat: number) => string,
): string | null {
  const seat = typeof ev.seat === 'number' ? ev.seat : null;
  const who = seat !== null ? nameForSeat(seat) : '';
  const amount = typeof ev.amount === 'number' ? ev.amount : undefined;

  switch (ev.type) {
    case 'HAND_STARTED':
      return `Hand #${ev.handNumber ?? ''} dealt`;
    case 'BLIND_POSTED':
      return `${who} posts ${ev.blind === 'SMALL' ? 'small' : 'big'} blind ${amount ?? ''}`;
    case 'PLAYER_FOLDED':
      return `${who} folds`;
    case 'PLAYER_CHECKED':
      return `${who} checks`;
    case 'PLAYER_CALLED':
      return `${who} calls ${amount ?? ''}`;
    case 'PLAYER_BET':
      return `${who} bets ${amount ?? ''}`;
    case 'PLAYER_RAISED':
      return `${who} raises to ${amount ?? ''}`;
    case 'PLAYER_WENT_ALL_IN':
      return `${who} is all in for ${amount ?? ''}`;
    case 'ACTION_TIMED_OUT':
      return `${who} timed out`;
    case 'FLOP_DEALT':
      return 'Flop';
    case 'TURN_DEALT':
      return 'Turn';
    case 'RIVER_DEALT':
      return 'River';
    case 'HAND_REVEALED': {
      const hi = (ev.hand as { description?: string } | undefined)?.description ?? '';
      const lo = (ev.low as { description?: string } | undefined)?.description;
      return `${who} shows ${hi}${lo ? ` (low: ${lo})` : ''}`.trim();
    }
    case 'HAND_MUCKED':
      return `${who} mucks`;
    case 'POT_AWARDED': {
      const winners = (ev.winners as { seat: number; amount: number }[] | undefined) ?? [];
      const label = winners.map((w) => `${nameForSeat(w.seat)} ${w.amount}`).join(', ');
      if (!label) return null;
      const portion = ev.portion === 'HIGH' ? 'High pot' : ev.portion === 'LOW' ? 'Low pot' : 'Pot';
      return `${portion} to ${label}`;
    }
    default:
      return null;
  }
}
