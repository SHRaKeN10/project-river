import { GameType, type LobbyTableView } from '@river/shared-types';

export type GameTabId = 'ALL' | `${GameType}`;

export const GAME_TABS: { id: GameTabId; label: string }[] = [
  { id: 'ALL', label: 'All' },
  { id: GameType.NLHE, label: "Hold'em" },
  { id: GameType.PLO, label: 'PLO' },
  { id: GameType.OMAHA5_HILO, label: 'Big O' },
];

export type StakeTierId = 'low' | 'mid' | 'high';

export const STAKE_TIERS: { id: StakeTierId; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'mid', label: 'Mid' },
  { id: 'high', label: 'High' },
];

/** Stakes bucket by big blind: low up to 10, mid up to 50, high above. */
export function stakeTierOf(bigBlind: number): StakeTierId {
  if (bigBlind <= 10) return 'low';
  if (bigBlind <= 50) return 'mid';
  return 'high';
}

/** Short badge shown on a table row. */
export function gameBadge(gameType: string): string {
  switch (gameType) {
    case GameType.NLHE:
      return 'NLH';
    case GameType.PLO:
      return 'PLO';
    case GameType.OMAHA5_HILO:
      return 'BIG O';
    default:
      return gameType;
  }
}

export interface LobbyFilters {
  game: GameTabId;
  tier: StakeTierId | null;
  openOnly: boolean;
  favoritesOnly: boolean;
}

export function filterTables(tables: LobbyTableView[], f: LobbyFilters): LobbyTableView[] {
  return tables.filter((t) => {
    if (f.game !== 'ALL' && t.gameType !== f.game) return false;
    if (f.tier && stakeTierOf(t.bigBlind) !== f.tier) return false;
    if (f.openOnly && t.openSeats === 0 && !t.onWaitlist) return false;
    if (f.favoritesOnly && !t.isFavorite) return false;
    return true;
  });
}
