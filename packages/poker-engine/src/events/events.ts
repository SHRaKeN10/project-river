import { type Card } from '../cards/card';
import { type HandCategory } from '../hand-evaluator/hand-rank';
import { Street } from '../game-state/game-state';

/** A lightweight, serializable snapshot of a made hand for the event log / UI. */
export interface HandRankSummary {
  readonly category: HandCategory;
  readonly tiebreakers: readonly number[];
  readonly cards: readonly Card[];
  readonly description: string;
}

/**
 * Every meaningful thing that happens in a hand. The engine emits these with no
 * sequence number or timestamp (it has no clock); the application layer stamps
 * and persists them. Replaying the ordered events from HAND_STARTED reproduces
 * the hand exactly.
 *
 * HOLE_CARDS_DEALT and HAND_REVEALED carry full card info - the application
 * layer is responsible for stripping other players' hole cards per recipient
 * before broadcasting.
 */
export type GameEvent =
  | {
      readonly type: 'HAND_STARTED';
      readonly handId: string;
      readonly handNumber: number;
      readonly buttonSeat: number;
      readonly smallBlindSeat: number | null;
      readonly bigBlindSeat: number;
      readonly players: readonly {
        readonly seat: number;
        readonly userId: string;
        readonly stack: number;
      }[];
    }
  | {
      readonly type: 'BLIND_POSTED';
      readonly seat: number;
      readonly amount: number;
      readonly blind: 'SMALL' | 'BIG';
    }
  | { readonly type: 'ANTE_POSTED'; readonly seat: number; readonly amount: number }
  | {
      readonly type: 'HOLE_CARDS_DEALT';
      readonly hands: readonly { readonly seat: number; readonly cards: readonly Card[] }[];
    }
  | { readonly type: 'PLAYER_FOLDED'; readonly seat: number }
  | { readonly type: 'PLAYER_CHECKED'; readonly seat: number }
  | {
      readonly type: 'PLAYER_CALLED';
      readonly seat: number;
      readonly amount: number;
      readonly allIn: boolean;
    }
  | {
      readonly type: 'PLAYER_BET';
      readonly seat: number;
      readonly amount: number;
      readonly allIn: boolean;
    }
  | {
      readonly type: 'PLAYER_RAISED';
      readonly seat: number;
      readonly amount: number;
      readonly allIn: boolean;
    }
  | { readonly type: 'PLAYER_WENT_ALL_IN'; readonly seat: number; readonly amount: number }
  | {
      readonly type: 'ACTION_TIMED_OUT';
      readonly seat: number;
      readonly resolvedAs: 'FOLD' | 'CHECK';
    }
  | {
      readonly type: 'ACTION_REJECTED';
      readonly seat: number;
      readonly code: string;
      readonly reason: string;
    }
  | { readonly type: 'BET_RETURNED'; readonly seat: number; readonly amount: number }
  | { readonly type: 'BETTING_ROUND_ENDED'; readonly street: Street; readonly collectedPot: number }
  | { readonly type: 'FLOP_DEALT'; readonly cards: readonly Card[]; readonly burned: Card }
  | { readonly type: 'TURN_DEALT'; readonly card: Card; readonly burned: Card }
  | { readonly type: 'RIVER_DEALT'; readonly card: Card; readonly burned: Card }
  | { readonly type: 'SHOWDOWN_STARTED' }
  | {
      readonly type: 'HAND_REVEALED';
      readonly seat: number;
      readonly cards: readonly Card[];
      readonly hand: HandRankSummary;
    }
  | { readonly type: 'HAND_MUCKED'; readonly seat: number }
  | {
      readonly type: 'POT_AWARDED';
      readonly potIndex: number;
      readonly potType: 'MAIN' | 'SIDE';
      readonly amount: number;
      readonly winners: readonly { readonly seat: number; readonly amount: number }[];
    }
  | {
      readonly type: 'HAND_COMPLETED';
      readonly results: readonly {
        readonly seat: number;
        readonly userId: string;
        readonly net: number;
        readonly stack: number;
      }[];
    };

export type GameEventType = GameEvent['type'];
