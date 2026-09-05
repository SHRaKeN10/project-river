import { GameVariant } from '@river/poker-engine';

/**
 * Maps the database `PokerGameType` (also the wire `gameType` string) onto the
 * engine's `GameVariant`. The single place the two enums meet - `table-manager`
 * uses it to build the engine config and `hands.service` to replay a hand.
 */
export function variantForGameType(gameType: string): GameVariant {
  switch (gameType) {
    case 'PLO':
      return GameVariant.Omaha;
    case 'NLHE':
    default:
      return GameVariant.Holdem;
  }
}
