import { type Card } from '../cards/card';

/** Lifecycle of a seated player within a hand. */
export enum PlayerStatus {
  /** Seated, will be dealt in on the next hand. */
  Waiting = 'WAITING',
  /** Dealt in and able to act. */
  Active = 'ACTIVE',
  /** Out of the hand. */
  Folded = 'FOLDED',
  /** In the hand but has no chips behind - cannot act further. */
  AllIn = 'ALL_IN',
  /** Seated but not being dealt in. */
  SittingOut = 'SITTING_OUT',
  /** Busted out (tournament) - seat effectively empty. */
  Eliminated = 'ELIMINATED',
}

/** The last voluntary action a player took this betting round. */
export enum PlayerActionType {
  Fold = 'FOLD',
  Check = 'CHECK',
  Call = 'CALL',
  Bet = 'BET',
  Raise = 'RAISE',
  AllIn = 'ALL_IN',
  PostSmallBlind = 'POST_SMALL_BLIND',
  PostBigBlind = 'POST_BIG_BLIND',
  PostAnte = 'POST_ANTE',
  PostBomb = 'POST_BOMB',
  SitOut = 'SIT_OUT',
  Return = 'RETURN',
}

export interface PlayerState {
  readonly userId: string;
  readonly seatNumber: number;
  /** Chips behind, not yet in the pot. */
  readonly stack: number;
  /** Chips committed in the current betting round. */
  readonly currentBet: number;
  /** Chips committed across every street of the current hand. */
  readonly totalInvested: number;
  readonly holeCards: readonly Card[];
  readonly status: PlayerStatus;
  readonly isDealer: boolean;
  readonly isSmallBlind: boolean;
  readonly isBigBlind: boolean;
  readonly lastAction: PlayerActionType | null;
  /**
   * Whether the player has taken a voluntary action at the current bet level.
   * Reset to false whenever a full bet/raise re-opens the action. Posting a
   * blind does NOT set this - the big blind still gets their option.
   */
  readonly hasActed: boolean;
}

export function createPlayer(userId: string, seatNumber: number, stack: number): PlayerState {
  if (!Number.isInteger(stack) || stack < 0) {
    throw new Error(`stack must be a non-negative integer, got ${stack}`);
  }
  return {
    userId,
    seatNumber,
    stack,
    currentBet: 0,
    totalInvested: 0,
    holeCards: [],
    status: PlayerStatus.Waiting,
    isDealer: false,
    isSmallBlind: false,
    isBigBlind: false,
    lastAction: null,
    hasActed: false,
  };
}

/** Still holds live cards (can win the pot): ACTIVE or ALL_IN. */
export function isInHand(player: PlayerState): boolean {
  return player.status === PlayerStatus.Active || player.status === PlayerStatus.AllIn;
}

/** Able to take an action right now. */
export function canAct(player: PlayerState): boolean {
  return player.status === PlayerStatus.Active;
}

/** Contesting the pot but not necessarily able to act (excludes folded / out). */
export function isContesting(player: PlayerState): boolean {
  return isInHand(player);
}

/**
 * Moves up to `amount` chips from the stack into the current bet. If the player
 * cannot cover it, they commit their whole stack and go all-in.
 * Returns the updated player and the number of chips actually committed.
 */
export function commitChips(
  player: PlayerState,
  amount: number,
): { player: PlayerState; committed: number } {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(`commit amount must be a non-negative integer, got ${amount}`);
  }
  const committed = Math.min(amount, player.stack);
  const stack = player.stack - committed;
  return {
    committed,
    player: {
      ...player,
      stack,
      currentBet: player.currentBet + committed,
      totalInvested: player.totalInvested + committed,
      status: stack === 0 && isInHand(player) ? PlayerStatus.AllIn : player.status,
    },
  };
}

/**
 * Posts an ante: moves up to `amount` "dead" chips from the stack straight
 * toward the pot. Unlike a bet or a blind it is **not** added to `currentBet`,
 * so it never reduces what the player owes to call - the ante is dead money.
 * It still counts as invested for pot / side-pot construction. A player whom
 * the ante empties goes all-in.
 * Returns the updated player and the number of chips actually posted.
 */
export function postAnte(
  player: PlayerState,
  amount: number,
): { player: PlayerState; committed: number } {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(`ante amount must be a non-negative integer, got ${amount}`);
  }
  const committed = Math.min(amount, player.stack);
  const stack = player.stack - committed;
  return {
    committed,
    player: {
      ...player,
      stack,
      totalInvested: player.totalInvested + committed,
      lastAction: committed > 0 ? PlayerActionType.PostAnte : player.lastAction,
      status: stack === 0 && isInHand(player) ? PlayerStatus.AllIn : player.status,
    },
  };
}

export function foldPlayer(player: PlayerState): PlayerState {
  return {
    ...player,
    status: PlayerStatus.Folded,
    lastAction: PlayerActionType.Fold,
    hasActed: true,
  };
}

export function markActed(player: PlayerState, action: PlayerActionType): PlayerState {
  return { ...player, lastAction: action, hasActed: true };
}

/** Clears per-round betting fields; keeps stack, status, hole cards, invested total. */
export function resetForStreet(player: PlayerState): PlayerState {
  return { ...player, currentBet: 0, hasActed: false, lastAction: null };
}

/** Prepares a player for a brand-new hand. A player with no chips is sat out
 * (they must top up), unless they were already eliminated. */
export function resetForHand(player: PlayerState): PlayerState {
  let status: PlayerStatus;
  if (player.status === PlayerStatus.Eliminated) {
    status = PlayerStatus.Eliminated;
  } else if (player.status === PlayerStatus.SittingOut || player.stack === 0) {
    status = PlayerStatus.SittingOut;
  } else {
    status = PlayerStatus.Active;
  }
  return {
    ...player,
    currentBet: 0,
    totalInvested: 0,
    holeCards: [],
    status,
    isDealer: false,
    isSmallBlind: false,
    isBigBlind: false,
    lastAction: null,
    hasActed: false,
  };
}
