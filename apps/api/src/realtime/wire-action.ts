import { allIn, betTo, call, check, fold, type PlayerAction, raiseTo } from '@river/poker-engine';
import type { WirePlayerAction } from '@river/shared-types';

/**
 * The one place a wire action becomes an engine action. Shared by the cash and
 * tournament gateways so the mapping (and its validation) lives in exactly one
 * spot - the poker rules themselves stay in the engine.
 */
export function toEngineAction(action: WirePlayerAction): PlayerAction {
  switch (action.type) {
    case 'FOLD':
      return fold();
    case 'CHECK':
      return check();
    case 'CALL':
      return call();
    case 'ALL_IN':
      return allIn();
    case 'BET':
      if (action.amount === undefined) throw new Error('bet requires an amount');
      return betTo(action.amount);
    case 'RAISE':
      if (action.amount === undefined) throw new Error('raise requires an amount');
      return raiseTo(action.amount);
    default:
      throw new Error('unknown action');
  }
}
