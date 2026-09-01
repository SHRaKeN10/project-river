import { type Card } from '../cards/card';
import { type GameEvent } from '../events/events';
import { type GameState } from '../game-state/game-state';
import { SeededRandomProvider } from '../rng/random-provider';
import { type TableConfig } from '../table/table';
import { type EngineAction, initGameState, reduce } from './reduce';

/**
 * Everything needed to reproduce one hand exactly. This is what the
 * application persists (see PokerHand / PokerHandEvent). Given the same
 * `deck` and the same ordered `actions`, `replayHand` returns a
 * bit-identical event stream and final state.
 */
export interface HandRecord {
  readonly tableId: string;
  readonly config: TableConfig;
  readonly seats: readonly { userId: string; seatNumber: number; stack: number }[];
  readonly handId: string;
  readonly handNumber: number;
  readonly previousButtonSeat: number | null;
  readonly deck: readonly Card[];
  /** The PLAYER_ACTION / TIMEOUT / SIT_OUT / RETURN sequence after START_HAND. */
  readonly actions: readonly EngineAction[];
}

export interface ReplayResult {
  readonly state: GameState;
  readonly events: GameEvent[];
}

export function replayHand(record: HandRecord): ReplayResult {
  // The deck is explicit, so the RNG is never consulted - a fixed seed keeps
  // replay independent of any environment.
  const rng = new SeededRandomProvider(0);
  const events: GameEvent[] = [];

  let state = initGameState({
    tableId: record.tableId,
    config: record.config,
    players: [...record.seats],
  });

  const started = reduce(
    state,
    {
      type: 'START_HAND',
      handId: record.handId,
      handNumber: record.handNumber,
      previousButtonSeat: record.previousButtonSeat,
      deck: record.deck,
    },
    rng,
  );
  state = started.state;
  events.push(...started.events);

  for (const action of record.actions) {
    const next = reduce(state, action, rng);
    state = next.state;
    events.push(...next.events);
  }

  return { state, events };
}
