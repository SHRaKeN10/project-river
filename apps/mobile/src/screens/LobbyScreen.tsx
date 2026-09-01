import { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { LobbyTableView } from '@river/shared-types';
import { EmptyState, FilterChip } from '../components';
import { useLobbyTables, useToggleFavorite, useWaitlist } from '../features/lobby/queries';
import { useLobbyLive } from '../features/lobby/useLobbyLive';
import { LobbyTableCard } from '../features/lobby/LobbyTableCard';
import { colors, spacing, typography } from '../theme/tokens';
import type { AppStackParams } from '../navigation/types';

type Props = NativeStackScreenProps<AppStackParams, 'Lobby'>;

interface StakeBucket {
  id: string;
  label: string;
  match: (bigBlind: number) => boolean;
}

const STAKE_BUCKETS: StakeBucket[] = [
  { id: 'micro', label: 'Micro', match: (bb) => bb <= 2 },
  { id: 'low', label: 'Low', match: (bb) => bb > 2 && bb <= 10 },
  { id: 'mid', label: 'Mid', match: (bb) => bb > 10 && bb <= 50 },
  { id: 'high', label: 'High', match: (bb) => bb > 50 },
];

export function LobbyScreen({ navigation }: Props): JSX.Element {
  const { data, isLoading, isError, refetch, isRefetching } = useLobbyTables();
  const favorite = useToggleFavorite();
  const waitlist = useWaitlist();

  const [bucket, setBucket] = useState<string | null>(null);
  const [openOnly, setOpenOnly] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);

  const openTable = useCallback(
    (tableId: string) => navigation.navigate('Table', { tableId }),
    [navigation],
  );

  // Keep the latest list in a ref so the socket callback stays referentially
  // stable (it must not re-subscribe on every live delta).
  const tablesRef = useRef<LobbyTableView[] | undefined>(undefined);
  tablesRef.current = data;

  const onSeatAvailable = useCallback(
    (tableId: string) => {
      const name = tablesRef.current?.find((t) => t.id === tableId)?.name ?? 'a table';
      Alert.alert('Seat available', `A seat opened up at ${name}.`, [
        { text: 'Later', style: 'cancel' },
        { text: 'Take seat', onPress: () => openTable(tableId) },
      ]);
    },
    [openTable],
  );

  useLobbyLive({ onSeatAvailable });

  const tables = useMemo(() => {
    if (!data) return [];
    const selected = STAKE_BUCKETS.find((b) => b.id === bucket);
    return data.filter((t) => {
      if (selected && !selected.match(t.bigBlind)) return false;
      if (openOnly && t.openSeats === 0 && !t.onWaitlist) return false;
      if (favoritesOnly && !t.isFavorite) return false;
      return true;
    });
  }, [data, bucket, openOnly, favoritesOnly]);

  const { mutate: mutateFavorite } = favorite;
  const { mutate: mutateWaitlist } = waitlist;
  const onToggleFavorite = useCallback(
    (t: LobbyTableView) => mutateFavorite({ tableId: t.id, next: !t.isFavorite }),
    [mutateFavorite],
  );
  const onToggleWaitlist = useCallback(
    (t: LobbyTableView) => mutateWaitlist({ tableId: t.id, next: !t.onWaitlist }),
    [mutateWaitlist],
  );

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View style={styles.filters}>
        <View style={styles.chipRow}>
          {STAKE_BUCKETS.map((b) => (
            <FilterChip
              key={b.id}
              label={b.label}
              active={bucket === b.id}
              onPress={() => setBucket((cur) => (cur === b.id ? null : b.id))}
            />
          ))}
        </View>
        <View style={styles.chipRow}>
          <FilterChip label="Open seats" active={openOnly} onPress={() => setOpenOnly((v) => !v)} />
          <FilterChip
            label="Favourites"
            active={favoritesOnly}
            onPress={() => setFavoritesOnly((v) => !v)}
          />
        </View>
      </View>

      <FlatList
        data={tables}
        keyExtractor={(t) => t.id}
        renderItem={({ item }) => (
          <LobbyTableCard
            table={item}
            onOpen={openTable}
            onToggleFavorite={onToggleFavorite}
            onToggleWaitlist={onToggleWaitlist}
            busy={waitlist.isPending}
          />
        )}
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={refetch}
            tintColor={colors.textSecondary}
          />
        }
        ListEmptyComponent={
          isLoading ? (
            <Text style={styles.muted}>Loading tables…</Text>
          ) : isError ? (
            <EmptyState
              title="Couldn't load the lobby"
              body="Check your connection and try again."
              actionLabel="Retry"
              onAction={refetch}
            />
          ) : (
            <EmptyState title="No tables match" body="Clear a filter to see more games." />
          )
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  filters: {
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  list: { padding: spacing.lg, flexGrow: 1 },
  sep: { height: spacing.md },
  muted: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: 'center',
    paddingVertical: spacing.xxl,
  },
});
