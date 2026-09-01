import type { LobbyTableView } from '@river/shared-types';
import { apiFetch } from '../api/client';

export interface LobbyQuery {
  minBigBlind?: number;
  maxBigBlind?: number;
  hasOpenSeat?: boolean;
  favoritesOnly?: boolean;
}

export const lobbyApi = {
  list: (query: LobbyQuery = {}) =>
    apiFetch<LobbyTableView[]>('/api/lobby', { query: { ...query } }),

  getOne: (tableId: string) => apiFetch<LobbyTableView>(`/api/lobby/${tableId}`),

  favorite: (tableId: string) =>
    apiFetch<void>(`/api/lobby/${tableId}/favorite`, { method: 'POST' }),

  unfavorite: (tableId: string) =>
    apiFetch<void>(`/api/lobby/${tableId}/favorite`, { method: 'DELETE' }),

  joinWaitlist: (tableId: string) =>
    apiFetch<{ position: number }>(`/api/lobby/${tableId}/waitlist`, { method: 'POST' }),

  leaveWaitlist: (tableId: string) =>
    apiFetch<void>(`/api/lobby/${tableId}/waitlist`, { method: 'DELETE' }),
};
