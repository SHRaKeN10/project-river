import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { chipsApi, tournamentsApi } from './endpoints';

export const queryKeys = {
  chips: ['chips'] as const,
  tournaments: ['tournaments'] as const,
  tournament: (id: string) => ['tournament', id] as const,
};

export function useChips() {
  return useQuery({ queryKey: queryKeys.chips, queryFn: chipsApi.balance });
}

export function useRebuy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: chipsApi.rebuy,
    onSuccess: (data) => qc.setQueryData(queryKeys.chips, data),
  });
}

export function useTournaments() {
  return useQuery({
    queryKey: queryKeys.tournaments,
    queryFn: tournamentsApi.list,
    refetchInterval: 5_000,
  });
}

export function useTournament(id: string) {
  return useQuery({
    queryKey: queryKeys.tournament(id),
    queryFn: () => tournamentsApi.get(id),
    refetchInterval: 4_000,
  });
}

export function useRegisterTournament() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => tournamentsApi.register(id),
    onSuccess: (view) => {
      qc.setQueryData(queryKeys.tournament(view.id), view);
      void qc.invalidateQueries({ queryKey: queryKeys.tournaments });
      void qc.invalidateQueries({ queryKey: queryKeys.chips });
    },
  });
}

export function useUnregisterTournament() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => tournamentsApi.unregister(id),
    onSuccess: (view) => {
      qc.setQueryData(queryKeys.tournament(view.id), view);
      void qc.invalidateQueries({ queryKey: queryKeys.tournaments });
      void qc.invalidateQueries({ queryKey: queryKeys.chips });
    },
  });
}
