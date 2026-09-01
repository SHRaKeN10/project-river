import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LobbyTableDelta, LobbyTableView } from '@river/shared-types';
import { lobbyApi } from './endpoints';

export const lobbyKeys = {
  all: ['lobby'] as const,
};

export function useLobbyTables() {
  return useQuery({
    queryKey: lobbyKeys.all,
    queryFn: () => lobbyApi.list(),
    staleTime: 10_000,
  });
}

/** Merge a live `lobby:update` delta into the cached table list. */
export function useApplyLobbyDelta() {
  const qc = useQueryClient();
  return useCallback(
    (delta: LobbyTableDelta) => {
      qc.setQueryData<LobbyTableView[]>(lobbyKeys.all, (prev) =>
        prev?.map((t) =>
          t.id === delta.id
            ? {
                ...t,
                seatedCount: delta.seatedCount,
                openSeats: delta.openSeats,
                waitlistCount: delta.waitlistCount,
                handInProgress: delta.handInProgress,
                avgPot: delta.avgPot,
                status: delta.status,
              }
            : t,
        ),
      );
    },
    [qc],
  );
}

function patchTable(
  qc: ReturnType<typeof useQueryClient>,
  tableId: string,
  patch: Partial<LobbyTableView>,
): LobbyTableView[] | undefined {
  const prev = qc.getQueryData<LobbyTableView[]>(lobbyKeys.all);
  qc.setQueryData<LobbyTableView[]>(lobbyKeys.all, (list) =>
    list?.map((t) => (t.id === tableId ? { ...t, ...patch } : t)),
  );
  return prev;
}

export function useToggleFavorite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tableId, next }: { tableId: string; next: boolean }) =>
      next ? lobbyApi.favorite(tableId) : lobbyApi.unfavorite(tableId),
    onMutate: async ({ tableId, next }) => {
      await qc.cancelQueries({ queryKey: lobbyKeys.all });
      const prev = patchTable(qc, tableId, { isFavorite: next });
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(lobbyKeys.all, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: lobbyKeys.all }),
  });
}

export function useWaitlist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ tableId, next }: { tableId: string; next: boolean }) => {
      if (next) await lobbyApi.joinWaitlist(tableId);
      else await lobbyApi.leaveWaitlist(tableId);
    },
    onMutate: async ({ tableId, next }) => {
      await qc.cancelQueries({ queryKey: lobbyKeys.all });
      const current = qc
        .getQueryData<LobbyTableView[]>(lobbyKeys.all)
        ?.find((t) => t.id === tableId);
      const delta = next ? 1 : -1;
      const prev = patchTable(qc, tableId, {
        onWaitlist: next,
        waitlistCount: Math.max(0, (current?.waitlistCount ?? 0) + delta),
      });
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(lobbyKeys.all, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: lobbyKeys.all }),
  });
}
