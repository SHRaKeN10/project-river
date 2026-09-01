import { type Card } from '../cards/card';
import { type BettingRound } from '../betting/betting';
import { type DeckState } from '../deck/deck';
import { canAct, isInHand, type PlayerState, PlayerStatus } from '../player/player';
import { type TableConfig } from '../table/table';

export enum Street {
  Waiting = 'WAITING',
  Preflop = 'PREFLOP',
  Flop = 'FLOP',
  Turn = 'TURN',
  River = 'RIVER',
  Showdown = 'SHOWDOWN',
  Complete = 'COMPLETE',
}

/** A (main or side) pot and the seats eligible to win it. Built by the
 * pot-manager module (STEP 4 part 2b); modelled here so GameState is complete. */
export interface Pot {
  readonly amount: number;
  readonly eligibleSeats: readonly number[];
}

/**
 * The complete authoritative state of one hand at a table. Immutable - the
 * reducer (part 2b) produces a new GameState per action. Everything needed to
 * replay the hand is here (`deck` carries its seed order + cursor).
 */
export interface GameState {
  readonly tableId: string;
  readonly handId: string;
  readonly handNumber: number;
  readonly config: TableConfig;

  readonly street: Street;
  /** May be an empty seat - a "dead button" (see `assignPositions`). */
  readonly buttonSeat: number;
  /** null = "dead small blind": none was posted this hand. */
  readonly smallBlindSeat: number | null;
  readonly bigBlindSeat: number;

  readonly communityCards: readonly Card[];
  /** Sorted ascending by seatNumber. */
  readonly players: readonly PlayerState[];
  readonly actingSeat: number | null;

  readonly round: BettingRound;
  readonly deck: DeckState;
  /** Chips gathered from betting rounds that have already closed. While the
   * hand is live this holds everything not currently on the table; at
   * completion the same chips are also broken out into `pots`. */
  readonly collectedPot: number;
  /** The resolved main + side pot breakdown. Empty until the hand completes. */
  readonly pots: readonly Pot[];

  /** Epoch millis by which the acting player must act, or null. Set by the
   * application layer, never by the engine (the engine has no clock). */
  readonly actionDeadline: number | null;
}

// ---------------------------------------------------------------------------
// selectors
// ---------------------------------------------------------------------------

export function getPlayer(state: GameState, seat: number): PlayerState | undefined {
  return state.players.find((p) => p.seatNumber === seat);
}

/** Players who can take an action (status ACTIVE). */
export function actingPlayers(state: GameState): PlayerState[] {
  return state.players.filter(canAct);
}

/** Players still holding cards (ACTIVE or ALL_IN). */
export function playersInHand(state: GameState): PlayerState[] {
  return state.players.filter(isInHand);
}

/** Players who have not folded and are contesting the pot. */
export function contestingPlayers(state: GameState): PlayerState[] {
  return state.players.filter((p) => p.status !== PlayerStatus.Folded && isInHand(p));
}

export function totalPot(state: GameState): number {
  const onTable = state.players.reduce((sum, p) => sum + p.currentBet, 0);
  const resolved = state.pots.reduce((sum, pot) => sum + pot.amount, 0);
  return onTable + (resolved > 0 ? resolved : state.collectedPot);
}

/** Chips a player must add to call the current bet (capped at their stack). */
export function toCall(state: GameState, seat: number): number {
  const player = getPlayer(state, seat);
  if (!player) return 0;
  return Math.min(player.stack, Math.max(0, state.round.currentBet - player.currentBet));
}

/** The hand is decided once only one player still holds cards, or it has run
 * to completion. */
export function isHandOver(state: GameState): boolean {
  if (state.street === Street.Complete) return true;
  return playersInHand(state).length <= 1;
}

/**
 * Next seat that can act, clockwise from `fromSeat` (exclusive). Returns null if
 * nobody else can act. `fromSeat` need not be occupied.
 */
export function nextActingSeat(state: GameState, fromSeat: number): number | null {
  const seats = actingPlayers(state)
    .map((p) => p.seatNumber)
    .sort((a, b) => a - b);
  if (seats.length === 0) return null;
  const ahead = seats.find((s) => s > fromSeat);
  return ahead ?? (seats[0] as number);
}
