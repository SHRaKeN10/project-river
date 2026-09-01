import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { chipsApi } from './endpoints';

export const queryKeys = {
  chips: ['chips'] as const,
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
