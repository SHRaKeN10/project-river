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

export const DEALER_BUTTON_SIZE = 26;
/** Rough rendered height of a seat pod (name row + cards + bet chip). */
const SEAT_POD_HEIGHT_ESTIMATE = 88;
/** Cash tables nudge each seat wrapper up by this much so the pod centres on its slot. */
export const SEAT_WRAP_RISE = 30;

/** Rough half-extent of the community board + pot pill, centred on the felt. */
const BOARD_HALF_WIDTH = 112;
const BOARD_HALF_HEIGHT = 50;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const overlaps = (a: Box, b: Box): boolean =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/**
 * Where to draw the dealer button for a seat: on the felt right next to the
 * pod, like a real puck. It prefers the side facing the middle of the table but
 * steps aside (above / below the pod, then outside it) when that spot would
 * cover the board or another seat. Returns the button's centre in px relative
 * to the felt, kept fully on the felt.
 *
 * `slots` is every seat on the table (so other pods can be avoided).
 */
export function dealerButtonPosition(
  slot: Pick<SeatSlot, 'x' | 'y'>,
  feltWidth: number,
  feltHeight: number,
  podWidth: number = SEAT_POD_MAX_WIDTH,
  seatRise: number = SEAT_WRAP_RISE,
  slots: Pick<SeatSlot, 'x' | 'y'>[] = [],
): { x: number; y: number } {
  const r = DEALER_BUTTON_SIZE / 2;
  const gap = 2;
  const podBox = (s: Pick<SeatSlot, 'x' | 'y'>): Box => {
    const cx = s.x * feltWidth;
    const top = s.y * feltHeight - seatRise;
    return {
      left: cx - podWidth / 2,
      right: cx + podWidth / 2,
      top,
      bottom: top + SEAT_POD_HEIGHT_ESTIMATE,
    };
  };
  const mine = podBox(slot);
  const podCx = (mine.left + mine.right) / 2;
  const podCy = (mine.top + mine.bottom) / 2;
  const dx = feltWidth / 2 - podCx;
  const dy = feltHeight / 2 - podCy;
  const len = Math.hypot(dx, dy);
  // A seat sitting dead-centre has no "in front"; treat it as facing up.
  const ux = len < 1 ? 0 : dx / len;
  const uy = len < 1 ? -1 : dy / len;
  const inward = dx >= 0 ? 1 : -1; // horizontal side facing the table centre

  // Walk out from the pod centre along the facing direction until the puck
  // clears the pod box grown by the puck radius plus a gap.
  const margin = r + gap;
  const reach = Math.min(
    ux === 0 ? Infinity : (podWidth / 2 + margin) / Math.abs(ux),
    uy === 0 ? Infinity : (SEAT_POD_HEIGHT_ESTIMATE / 2 + margin) / Math.abs(uy),
  );
  const innerX = podCx + inward * (podWidth / 2 - r);
  const candidates = [
    { x: podCx + ux * reach, y: podCy + uy * reach }, // in front, towards the centre
    { x: innerX, y: mine.top - margin }, // above the pod, inner corner
    { x: innerX, y: mine.bottom + margin }, // below the pod, inner corner
    { x: podCx - inward * (podWidth / 2 - r), y: mine.top - margin }, // above, outer corner
    { x: podCx - inward * (podWidth / 2 - r), y: mine.bottom + margin }, // below, outer corner
    { x: podCx + inward * (podWidth / 2 + margin), y: podCy }, // beside, inner
    { x: podCx - inward * (podWidth / 2 + margin), y: podCy }, // beside, outer
  ];

  const blockers: Box[] = [
    {
      left: feltWidth / 2 - BOARD_HALF_WIDTH,
      right: feltWidth / 2 + BOARD_HALF_WIDTH,
      top: feltHeight / 2 - BOARD_HALF_HEIGHT,
      bottom: feltHeight / 2 + BOARD_HALF_HEIGHT,
    },
    ...slots.filter((s) => s.x !== slot.x || s.y !== slot.y).map(podBox),
  ];
  const clearOf = (c: { x: number; y: number }, avoid: Box[]): boolean => {
    const box: Box = { left: c.x - r, right: c.x + r, top: c.y - r, bottom: c.y + r };
    const onFelt =
      box.left >= 0 && box.top >= 0 && box.right <= feltWidth && box.bottom <= feltHeight;
    return onFelt && !avoid.some((b) => overlaps(box, b));
  };
  // Best: clear of the board and every pod. On a very cramped felt settle for
  // just keeping the cards uncovered.
  const pick =
    candidates.find((c) => clearOf(c, [...blockers, mine])) ??
    candidates.find((c) => clearOf(c, [blockers[0]!])) ??
    candidates[0]!;
  return {
    x: Math.max(r, Math.min(feltWidth - r, pick.x)),
    y: Math.max(r, Math.min(feltHeight - r, pick.y)),
  };
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

/** What each seat showed at showdown this hand (high and, for hi-lo, low), so the
 * pot line can say what actually won. */
export type ShownHands = Map<number, { hi?: string; lo?: string }>;

const descriptionOf = (x: unknown): string | undefined =>
  (x as { description?: string } | undefined)?.description;

/** `describeEvent` plus a per-hand memory of revealed hands, for the live feed. */
export function createEventDescriber(
  nameForSeat: (seat: number) => string,
): (ev: HandUpdateEvent) => string | null {
  const shown: ShownHands = new Map();
  return (ev) => {
    if (ev.type === 'HAND_STARTED') shown.clear();
    else if (ev.type === 'HAND_REVEALED' && typeof ev.seat === 'number') {
      shown.set(ev.seat, { hi: descriptionOf(ev.hand), lo: descriptionOf(ev.low) });
    }
    return describeEvent(ev, nameForSeat, shown);
  };
}

/** Turn a stripped `hand:update` event into one short feed line, or null to skip. */
export function describeEvent(
  ev: HandUpdateEvent,
  nameForSeat: (seat: number) => string,
  shown?: ShownHands,
): string | null {
  const seat = typeof ev.seat === 'number' ? ev.seat : null;
  const who = seat !== null ? nameForSeat(seat) : '';
  const amount = typeof ev.amount === 'number' ? ev.amount : undefined;

  switch (ev.type) {
    case 'HAND_STARTED':
      return `Hand #${ev.handNumber ?? ''} dealt`;
    case 'BLIND_POSTED':
      return `${who} posts ${ev.blind === 'SMALL' ? 'small' : 'big'} blind ${amount ?? ''}`;
    case 'ANTE_POSTED':
      return `${who} posts ante ${amount ?? ''}`;
    case 'BOMB_POT_STARTED':
      return `Bomb pot! Everyone posts ${amount ?? ''} - no preflop betting`;
    case 'BOMB_POT_POSTED':
      return `${who} posts bomb ${amount ?? ''}`;
    case 'STRADDLE_POSTED':
      return `${who} straddles ${amount ?? ''}`;
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
    case 'SECOND_BOARD_DEALT':
      return 'Running it twice — second board';
    case 'HAND_REVEALED': {
      const hi = (ev.hand as { description?: string } | undefined)?.description ?? '';
      const lo = (ev.low as { description?: string } | undefined)?.description;
      return `${who} shows ${hi}${lo ? ` (low: ${lo})` : ''}`.trim();
    }
    case 'HAND_MUCKED':
      return `${who} mucks`;
    case 'POT_AWARDED': {
      const winners = (ev.winners as { seat: number; amount: number }[] | undefined) ?? [];
      if (winners.length === 0) return null;
      const portion = ev.portion === 'HIGH' ? 'High pot' : ev.portion === 'LOW' ? 'Low pot' : 'Pot';
      const board = ev.board === 1 ? ' (board 1)' : ev.board === 2 ? ' (board 2)' : '';
      // The hand each winner showed for this side of the pot. Nobody shows
      // down on a fold-out win, so those keep the plain "Pot to ..." line.
      const hands = winners.map((w) => {
        const h = shown?.get(w.seat);
        return ev.portion === 'LOW' ? h?.lo : h?.hi;
      });
      if (hands.every((h) => !h)) {
        const label = winners.map((w) => `${nameForSeat(w.seat)} ${w.amount}`).join(', ');
        return `${portion} to ${label}${board}`;
      }
      const label = winners
        .map(
          (w, i) => `${nameForSeat(w.seat)} wins ${w.amount}${hands[i] ? ` with ${hands[i]}` : ''}`,
        )
        .join('; ');
      return `${ev.portion ? `${portion}: ` : ''}${label}${board}`;
    }
    default:
      return null;
  }
}
