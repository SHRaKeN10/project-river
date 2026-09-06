import { useCallback } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { TournamentView } from '@river/shared-types';
import { Button, EmptyState, Tag } from '../components';
import {
  useRegisterTournament,
  useTournaments,
  useUnregisterTournament,
} from '../features/api/queries';
import { colors, radius, spacing, typography } from '../theme/tokens';
import type { AppStackParams } from '../navigation/types';

type Props = NativeStackScreenProps<AppStackParams, 'Tournaments'>;

const STATUS_LABEL: Record<string, string> = {
  SCHEDULED: 'Registering',
  REGISTERING: 'Registering',
  RUNNING: 'Running',
  PAUSED: 'On break',
  FINISHED: 'Finished',
  CANCELLED: 'Cancelled',
};

export function TournamentsScreen({ navigation }: Props): JSX.Element {
  const { data, isLoading, isError, refetch, isRefetching } = useTournaments();
  const register = useRegisterTournament();
  const unregister = useUnregisterTournament();

  const enter = useCallback(
    (id: string) => navigation.navigate('TournamentTable', { tournamentId: id }),
    [navigation],
  );

  const renderItem = useCallback(
    ({ item }: { item: TournamentView }) => {
      const registered = item.you !== null;
      const canRegister =
        !registered && (item.status === 'SCHEDULED' || item.status === 'REGISTERING');
      const running = item.status === 'RUNNING' || item.status === 'PAUSED';
      const eliminated = item.you?.eliminated ?? false;

      return (
        <View style={styles.card}>
          <View style={styles.cardTop}>
            <Text style={styles.name} numberOfLines={1}>
              {item.name}
            </Text>
            <Tag label={STATUS_LABEL[item.status] ?? item.status} />
          </View>
          <Text style={styles.meta}>
            {item.gameType} · {item.buyIn} buy-in · {item.startingStack} stack
          </Text>
          <Text style={styles.meta}>
            {item.entrantCount} entered
            {running ? ` · ${item.playersLeft} left · ${item.placesPaid} paid` : ''}
          </Text>

          <View style={styles.actions}>
            {canRegister ? (
              <Button
                label={register.isPending ? 'Registering…' : 'Register'}
                onPress={() => register.mutate(item.id)}
              />
            ) : null}
            {registered && !running && item.status !== 'FINISHED' ? (
              <Button
                label="Unregister"
                variant="secondary"
                onPress={() => unregister.mutate(item.id)}
              />
            ) : null}
            {registered && running && !eliminated ? (
              <Button label="Enter table" onPress={() => enter(item.id)} />
            ) : null}
            {registered && running && eliminated ? (
              <Text style={styles.meta}>
                Busted{item.you?.finishPosition ? ` in ${item.you.finishPosition}` : ''}
              </Text>
            ) : null}
          </View>
        </View>
      );
    },
    [enter, register, unregister],
  );

  return (
    <SafeAreaView style={styles.root} edges={['bottom']}>
      {isError ? (
        <EmptyState title="Couldn’t load tournaments" body="Pull to retry." />
      ) : (
        <FlatList
          data={data ?? []}
          keyExtractor={(t) => t.id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} />
          }
          ListEmptyComponent={
            isLoading ? null : (
              <EmptyState title="No tournaments" body="Nothing scheduled right now." />
            )
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  list: { padding: spacing.lg, gap: spacing.md },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  name: { ...typography.h3, color: colors.textPrimary, flex: 1, marginRight: spacing.sm },
  meta: { ...typography.caption, color: colors.textSecondary },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
});
