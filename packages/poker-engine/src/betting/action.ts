/**
 * A voluntary player action within a betting round.
 *
 * For BET and RAISE, `amount` is the "raise to" total - the value the player's
 * `currentBet` for the round becomes, not the incremental chips. (For an
 * opening BET the round's currentBet is 0, so the two are equal.)
 *
 * ALL_IN is a convenience the validator/reducer expands into the equivalent
 * BET / CALL / RAISE for the player's whole stack.
 */
export type PlayerAction =
  | { readonly type: 'FOLD' }
  | { readonly type: 'CHECK' }
  | { readonly type: 'CALL' }
  | { readonly type: 'BET'; readonly amount: number }
  | { readonly type: 'RAISE'; readonly amount: number }
  | { readonly type: 'ALL_IN' };

export type PlayerActionKind = PlayerAction['type'];

export const fold = (): PlayerAction => ({ type: 'FOLD' });
export const check = (): PlayerAction => ({ type: 'CHECK' });
export const call = (): PlayerAction => ({ type: 'CALL' });
export const betTo = (amount: number): PlayerAction => ({ type: 'BET', amount });
export const raiseTo = (amount: number): PlayerAction => ({ type: 'RAISE', amount });
export const allIn = (): PlayerAction => ({ type: 'ALL_IN' });
