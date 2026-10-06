import { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import type { LobbyTableView, WaitlistSeatAvailable } from '@river/shared-types';
import { EmptyState, FilterChip, SegmentedTabs } from '../components';
import { useLobbyTables, useToggleFavorite, useWaitlist } from '../features/lobby/queries';
import { useLobbyLive } from '../features/lobby/useLobbyLive';
import { useSocketConnected } from '../features/realtime/useSocketConnected';
import { LobbyTableCard } from '../features/lobby/LobbyTableCard';
import {
  filterTables,
  GAME_TABS,
  STAKE_TIERS,
  type GameTabId,
  type StakeTierId,
} from '../features/lobby/filters';
import { colors, spacing, typography } from '../theme/tokens';
import type { AppNavigation } from '../navigation/types';

interface Props {
  navigation: AppNavigation;
}

/** The Cash tab: pick a game, optionally a stakes tier, tap a table. */
export function LobbyScreen({ navigation }: Props): JSX.Element {
  const { data, isLoading, isError, refetch, isRefetching } = useLobbyTables();
  const online = useSocketConnected();
  const favorite = useToggleFavorite();
  const waitlist = useWaitlist();

  const [game, setGame] = useState<GameTabId>('ALL');
  const [tier, setTier] = useState<StakeTierId | null>(null);
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
    ({ tableId, seatNumber, expiresAt }: WaitlistSeatAvailable) => {
      const name = tablesRef.current?.find((t) => t.id === tableId)?.name ?? 'a table';
      const secs = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      Alert.alert(
        'Your seat is ready',
        `A seat opened up at ${name}. It's held for you for about ${secs}s.`,
        [
          { text: 'Pass', style: 'cancel' },
          {
            text: 'Take seat',
            onPress: () => navigation.navigate('Table', { tableId, claimSeat: seatNumber }),
          },
        ],
      );
    },
    [navigation],
  );

  useLobbyLive({ onSeatAvailable });

  const tables = useMemo(
    () => filterTables(data ?? [], { game, tier, openOnly, favoritesOnly }),
    [data, game, tier, openOnly, favoritesOnly],
  );

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
    <View style={styles.root}>
      {!online ? (
        <View style={styles.offlineBar}>
          <Text style={styles.offlineText}>Reconnecting… live updates paused</Text>
        </View>
      ) : null}

      <View style={styles.filters}>
        <SegmentedTabs items={GAME_TABS} active={game} onChange={setGame} />
        <View style={styles.chipRow}>
          {STAKE_TIERS.map((s) => (
            <FilterChip
              key={s.id}
              label={s.label}
              active={tier === s.id}
              onPress={() => setTier((cur) => (cur === s.id ? null : s.id))}
            />
          ))}
          <View style={styles.spacer} />
          <FilterChip label="Open" active={openOnly} onPress={() => setOpenOnly((v) => !v)} />
          <FilterChip
            label="★"
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
            <EmptyState title="No tables match" body="Try another game or clear a filter." />
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  offlineBar: { backgroundColor: colors.surfaceAlt, paddingVertical: spacing.xs },
  offlineText: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  filters: {
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  chipRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  spacer: { flex: 1 },
  list: { padding: spacing.lg, flexGrow: 1 },
  sep: { height: spacing.md },
  muted: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: 'center',
    paddingVertical: spacing.xxl,
  },
});
