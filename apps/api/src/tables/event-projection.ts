import { cardToString, type GameEvent, isCard } from '@river/poker-engine';
import type { HandUpdateEvent } from '@river/shared-types';

/**
 * Turns an engine event into the form a specific viewer is allowed to receive
 * as `hand:update`:
 *  - Card objects become compact strings.
 *  - Burn cards are stripped (they are never shown in poker).
 *  - HOLE_CARDS_DEALT reveals only the viewer's own cards.
 *  - ACTION_REJECTED is never broadcast (the gateway replies to the actor directly).
 *
 * Returns null when the event should not be sent to this viewer at all.
 */
export function projectEvent(event: GameEvent, viewerSeat: number | null): HandUpdateEvent | null {
  switch (event.type) {
    case 'ACTION_REJECTED':
      return null;

    case 'HOLE_CARDS_DEALT':
      return {
        type: event.type,
        hands: event.hands.map((hand) => ({
          seat: hand.seat,
          cards: hand.seat === viewerSeat ? hand.cards.map(cardToString) : null,
          cardCount: hand.cards.length,
        })),
      };

    case 'FLOP_DEALT':
      return { type: event.type, cards: event.cards.map(cardToString) };
    case 'TURN_DEALT':
      return { type: event.type, card: cardToString(event.card) };
    case 'RIVER_DEALT':
      return { type: event.type, card: cardToString(event.card) };

    case 'HAND_REVEALED':
      return {
        type: event.type,
        seat: event.seat,
        cards: event.cards.map(cardToString),
        hand: {
          category: event.hand.category,
          description: event.hand.description,
          cards: event.hand.cards.map(cardToString),
        },
      };

    default:
      return { type: event.type, ...sanitize(event) };
  }
}

/** Recursively convert any Card values to strings; drop the `type` key (already set). */
function sanitize(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof value !== 'object' || value === null) return out;
  for (const [key, val] of Object.entries(value)) {
    if (key === 'type') continue;
    out[key] = sanitizeValue(val);
  }
  return out;
}

function sanitizeValue(val: unknown): unknown {
  if (isCard(val)) return cardToString(val);
  if (Array.isArray(val)) return val.map(sanitizeValue);
  if (typeof val === 'object' && val !== null) {
    return Object.fromEntries(Object.entries(val).map(([k, v]) => [k, sanitizeValue(v)]));
  }
  return val;
}

/** Seats whose hole cards this event batch makes public. */
export function revealedByEvents(events: readonly GameEvent[]): number[] {
  return events.filter((e) => e.type === 'HAND_REVEALED').map((e) => (e as { seat: number }).seat);
}
