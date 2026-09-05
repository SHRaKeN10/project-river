import {
  amountToCall,
  type BettingContext,
  minRaiseTo,
  type PlayerAction,
  type PlayerActionKind,
  potLimitMaxTo,
} from '../betting';
import { canAct, type PlayerState } from '../player/player';

export enum ValidationCode {
  NotYourTurn = 'NOT_YOUR_TURN',
  CannotAct = 'CANNOT_ACT',
  CannotCheck = 'CANNOT_CHECK',
  NothingToCall = 'NOTHING_TO_CALL',
  BetNotAllowed = 'BET_NOT_ALLOWED',
  RaiseNotAllowed = 'RAISE_NOT_ALLOWED',
  BelowMinimum = 'BELOW_MINIMUM',
  AboveMaximum = 'ABOVE_MAXIMUM',
  InsufficientChips = 'INSUFFICIENT_CHIPS',
  InvalidAmount = 'INVALID_AMOUNT',
}

/** Largest legal "raise to" total for the acting seat: the whole stack under
 * no-limit, the pot-limit cap under pot-limit. */
function maxToFor(ctx: BettingContext, player: PlayerState): number {
  const stackMax = player.currentBet + player.stack;
  if (ctx.bettingLimit !== 'POT_LIMIT') return stackMax;
  return Math.min(stackMax, potLimitMaxTo(ctx, player.seatNumber));
}

export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ValidationCode; readonly reason: string };

const ok: ValidationResult = { ok: true };
const fail = (code: ValidationCode, reason: string): ValidationResult => ({
  ok: false,
  code,
  reason,
});

/**
 * The single gate every player action passes through. The server rejects any
 * action for which this does not return `{ ok: true }` - the client's opinion
 * is never trusted.
 */
export function validateAction(
  ctx: BettingContext,
  seat: number,
  action: PlayerAction,
): ValidationResult {
  if (seat !== ctx.actingSeat) {
    return fail(ValidationCode.NotYourTurn, 'it is not your turn to act');
  }
  const player = ctx.players.find((p) => p.seatNumber === seat);
  if (!player) return fail(ValidationCode.NotYourTurn, `no player at seat ${seat}`);
  if (!canAct(player)) return fail(ValidationCode.CannotAct, 'you cannot act in this state');

  const owed = amountToCall(player.currentBet, ctx.round);

  switch (action.type) {
    case 'FOLD':
      return ok;

    case 'CHECK':
      return owed === 0 ? ok : fail(ValidationCode.CannotCheck, 'you cannot check facing a bet');

    case 'CALL':
      return owed > 0 ? ok : fail(ValidationCode.NothingToCall, 'there is nothing to call');

    case 'ALL_IN':
      return player.stack > 0 ? ok : fail(ValidationCode.InvalidAmount, 'you have no chips');

    case 'BET':
      return validateBet(ctx, player, action.amount);

    case 'RAISE':
      return validateRaise(ctx, player, action.amount, owed);

    default: {
      const exhaustive: never = action;
      return fail(ValidationCode.InvalidAmount, `unknown action ${JSON.stringify(exhaustive)}`);
    }
  }
}

function validateBet(ctx: BettingContext, player: PlayerState, amount: number): ValidationResult {
  if (ctx.round.currentBet !== 0) {
    return fail(ValidationCode.BetNotAllowed, 'there is already a bet - raise instead');
  }
  if (!Number.isInteger(amount) || amount <= player.currentBet) {
    return fail(ValidationCode.InvalidAmount, 'bet amount must be a positive integer');
  }
  const required = amount - player.currentBet;
  if (required > player.stack) {
    return fail(ValidationCode.InsufficientChips, 'you cannot bet more than your stack');
  }
  const isAllIn = required === player.stack;
  if (amount < ctx.round.minOpen && !isAllIn) {
    return fail(ValidationCode.BelowMinimum, `minimum bet is ${ctx.round.minOpen}`);
  }
  const maxTo = maxToFor(ctx, player);
  if (amount > maxTo) {
    return fail(ValidationCode.AboveMaximum, `maximum bet is ${maxTo} (pot limit)`);
  }
  return ok;
}

function validateRaise(
  ctx: BettingContext,
  player: PlayerState,
  amount: number,
  owed: number,
): ValidationResult {
  if (ctx.round.currentBet === 0) {
    return fail(ValidationCode.RaiseNotAllowed, 'there is no bet to raise - bet instead');
  }
  if (player.hasActed) {
    return fail(
      ValidationCode.RaiseNotAllowed,
      'the action has not been re-opened to you (an incomplete all-in does not re-open betting)',
    );
  }
  if (!Number.isInteger(amount)) {
    return fail(ValidationCode.InvalidAmount, 'raise amount must be an integer');
  }
  const required = amount - player.currentBet;
  if (required <= owed) {
    return fail(ValidationCode.InvalidAmount, 'a raise must be more than a call');
  }
  if (amount > player.currentBet + player.stack) {
    return fail(ValidationCode.InsufficientChips, 'you cannot raise more than your stack allows');
  }
  const potMaxTo = maxToFor(ctx, player);
  if (amount > potMaxTo) {
    return fail(ValidationCode.AboveMaximum, `maximum raise is to ${potMaxTo} (pot limit)`);
  }
  const isAllIn = required === player.stack;
  const raiseIncrement = amount - ctx.round.currentBet;
  if (raiseIncrement < ctx.round.lastRaiseSize && !isAllIn) {
    return fail(ValidationCode.BelowMinimum, `minimum raise is to ${minRaiseTo(ctx.round)}`);
  }
  return ok;
}

export interface ActionOption {
  readonly kind: PlayerActionKind;
  /** CALL: chips required, capped at the player's stack. */
  readonly callAmount?: number;
  /** BET / RAISE: the minimum and maximum legal "raise to" totals. */
  readonly min?: number;
  readonly max?: number;
}

/**
 * Enumerates every legal action for the player to act, with sizing bounds -
 * drives the client's action bar. The server still re-validates the chosen
 * action with `validateAction`.
 */
export function legalActions(ctx: BettingContext, seat: number): ActionOption[] {
  if (seat !== ctx.actingSeat) return [];
  const player = ctx.players.find((p) => p.seatNumber === seat);
  if (!player || !canAct(player)) return [];

  const owed = amountToCall(player.currentBet, ctx.round);
  const stackTo = player.currentBet + player.stack;
  // Under pot-limit the "raise to" ceiling is the pot cap; under no-limit it is
  // the whole stack.
  const maxTo = maxToFor(ctx, player);
  const canFullRaise = minRaiseTo(ctx.round) <= maxTo || stackTo <= maxTo;
  const options: ActionOption[] = [{ kind: 'FOLD' }];

  if (owed === 0) {
    options.push({ kind: 'CHECK' });
    if (ctx.round.currentBet === 0) {
      options.push({ kind: 'BET', min: Math.min(ctx.round.minOpen, maxTo), max: maxTo });
    } else if (!player.hasActed && canFullRaise) {
      options.push({ kind: 'RAISE', min: Math.min(minRaiseTo(ctx.round), maxTo), max: maxTo });
    }
  } else {
    options.push({ kind: 'CALL', callAmount: Math.min(owed, player.stack) });
    if (!player.hasActed && player.stack > owed && canFullRaise) {
      options.push({ kind: 'RAISE', min: Math.min(minRaiseTo(ctx.round), maxTo), max: maxTo });
    }
  }

  if (player.stack > 0) options.push({ kind: 'ALL_IN' });
  return options;
}
