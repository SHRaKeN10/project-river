import {
  canAct,
  commitChips,
  foldPlayer,
  isInHand,
  markActed,
  type PlayerState,
  PlayerActionType,
} from '../player/player';

/** State of a single betting round (pre-flop, flop, turn, or river). */
export interface BettingRound {
  /** Highest amount any player has committed this round - the amount to match. */
  readonly currentBet: number;
  /** Size of the last full bet/raise increment; the minimum legal raise increment. */
  readonly lastRaiseSize: number;
  /** Seat of the last player to bet or raise this round, or null. */
  readonly lastAggressorSeat: number | null;
  /** Minimum opening bet this round (the big blind). */
  readonly minOpen: number;
}

export interface BettingContext {
  readonly players: readonly PlayerState[];
  readonly round: BettingRound;
  readonly actingSeat: number;
}

export function createBettingRound(bigBlind: number, currentBet = 0): BettingRound {
  return { currentBet, lastRaiseSize: bigBlind, lastAggressorSeat: null, minOpen: bigBlind };
}

export function amountToCall(playerCurrentBet: number, round: BettingRound): number {
  return Math.max(0, round.currentBet - playerCurrentBet);
}

/** The smallest legal "raise to" total against the current round. */
export function minRaiseTo(round: BettingRound): number {
  return round.currentBet + round.lastRaiseSize;
}

// ---------------------------------------------------------------------------
// applying actions
// ---------------------------------------------------------------------------

class BettingRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BettingRuleError';
  }
}

function playerAt(players: readonly PlayerState[], seat: number): PlayerState {
  const player = players.find((p) => p.seatNumber === seat);
  if (!player) throw new BettingRuleError(`no player at seat ${seat}`);
  return player;
}

function withPlayer(players: readonly PlayerState[], updated: PlayerState): PlayerState[] {
  return players.map((p) => (p.seatNumber === updated.seatNumber ? updated : p));
}

/** Re-opens the action: every other player still in the hand must act again. */
function reopenActionForOthers(players: readonly PlayerState[], exceptSeat: number): PlayerState[] {
  return players.map((p) =>
    p.seatNumber !== exceptSeat && isInHand(p) && p.hasActed ? { ...p, hasActed: false } : p,
  );
}

export function applyFold(ctx: BettingContext): BettingContext {
  const player = playerAt(ctx.players, ctx.actingSeat);
  if (!canAct(player)) throw new BettingRuleError(`seat ${ctx.actingSeat} cannot act`);
  return { ...ctx, players: withPlayer(ctx.players, foldPlayer(player)) };
}

export function applyCheck(ctx: BettingContext): BettingContext {
  const player = playerAt(ctx.players, ctx.actingSeat);
  if (!canAct(player)) throw new BettingRuleError(`seat ${ctx.actingSeat} cannot act`);
  if (amountToCall(player.currentBet, ctx.round) !== 0) {
    throw new BettingRuleError('cannot check facing a bet');
  }
  return { ...ctx, players: withPlayer(ctx.players, markActed(player, PlayerActionType.Check)) };
}

export function applyCall(ctx: BettingContext): BettingContext {
  const player = playerAt(ctx.players, ctx.actingSeat);
  if (!canAct(player)) throw new BettingRuleError(`seat ${ctx.actingSeat} cannot act`);
  const owed = amountToCall(player.currentBet, ctx.round);
  if (owed === 0) throw new BettingRuleError('nothing to call - check instead');

  const { player: committed } = commitChips(player, owed);
  const acted = markActed(committed, PlayerActionType.Call);
  // A call never changes currentBet or the raise size.
  return { ...ctx, players: withPlayer(ctx.players, acted) };
}

export function applyBet(ctx: BettingContext, toAmount: number): BettingContext {
  const player = playerAt(ctx.players, ctx.actingSeat);
  if (!canAct(player)) throw new BettingRuleError(`seat ${ctx.actingSeat} cannot act`);
  if (ctx.round.currentBet !== 0)
    throw new BettingRuleError('there is already a bet - raise instead');

  const required = toAmount - player.currentBet;
  if (required <= 0) throw new BettingRuleError('bet amount must be positive');
  const isAllIn = required >= player.stack;
  if (toAmount < ctx.round.minOpen && !isAllIn) {
    throw new BettingRuleError(`minimum bet is ${ctx.round.minOpen}`);
  }

  const { player: committed } = commitChips(player, required);
  const betSize = committed.currentBet;
  const acted = markActed(committed, PlayerActionType.Bet);
  const players = reopenActionForOthers(withPlayer(ctx.players, acted), ctx.actingSeat);

  return {
    ...ctx,
    players,
    round: {
      currentBet: betSize,
      // A sub-minimum all-in bet does not shrink the next player's minimum raise.
      lastRaiseSize: Math.max(betSize, ctx.round.minOpen),
      lastAggressorSeat: ctx.actingSeat,
      minOpen: ctx.round.minOpen,
    },
  };
}

export function applyRaise(ctx: BettingContext, toAmount: number): BettingContext {
  const player = playerAt(ctx.players, ctx.actingSeat);
  if (!canAct(player)) throw new BettingRuleError(`seat ${ctx.actingSeat} cannot act`);
  if (ctx.round.currentBet === 0) throw new BettingRuleError('no bet to raise - bet instead');

  const owed = amountToCall(player.currentBet, ctx.round);
  const required = toAmount - player.currentBet;
  if (required <= owed) throw new BettingRuleError('a raise must exceed a call');

  const isAllIn = required >= player.stack;
  const raiseIncrement = toAmount - ctx.round.currentBet;
  if (raiseIncrement < ctx.round.lastRaiseSize && !isAllIn) {
    throw new BettingRuleError(`minimum raise is to ${minRaiseTo(ctx.round)}`);
  }

  const { player: committed } = commitChips(player, required);
  const newTotal = committed.currentBet;
  const actualIncrement = newTotal - ctx.round.currentBet;
  const newCurrentBet = Math.max(ctx.round.currentBet, newTotal);
  const isFullRaise = actualIncrement >= ctx.round.lastRaiseSize;

  const acted = markActed(committed, PlayerActionType.Raise);
  const players = isFullRaise
    ? reopenActionForOthers(withPlayer(ctx.players, acted), ctx.actingSeat)
    : withPlayer(ctx.players, acted);

  return {
    ...ctx,
    players,
    round: {
      currentBet: newCurrentBet,
      // An incomplete (sub-minimum) all-in raise does NOT increase the minimum
      // raise for the next player, and does not re-open the action.
      lastRaiseSize: isFullRaise ? actualIncrement : ctx.round.lastRaiseSize,
      lastAggressorSeat: ctx.actingSeat,
      minOpen: ctx.round.minOpen,
    },
  };
}

/**
 * True when the current betting round is finished: either the hand is decided
 * (≤1 player still holds cards), nobody left can act, or every player who can
 * act has both acted and matched the current bet.
 */
export function isBettingRoundComplete(ctx: BettingContext): boolean {
  const contesting = ctx.players.filter(isInHand);
  if (contesting.length <= 1) return true;

  const canStillAct = ctx.players.filter(canAct);
  if (canStillAct.length === 0) return true;

  return canStillAct.every((p) => p.hasActed && p.currentBet === ctx.round.currentBet);
}
