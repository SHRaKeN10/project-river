import { useCallback } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { BlindLevelWire } from '@river/shared-types';
import { Button, EmptyState, Tag } from '../components';
import {
  useRegisterTournament,
  useTournament,
  useUnregisterTournament,
} from '../features/api/queries';
import { TournamentClock } from '../features/tournament/TournamentClock';
import { colors, radius, spacing, typography } from '../theme/tokens';
import type { AppStackParams } from '../navigation/types';

type Props = NativeStackScreenProps<AppStackParams, 'TournamentDetail'>;

const STATUS_LABEL: Record<string, string> = {
  SCHEDULED: 'Registering',
  REGISTERING: 'Registering',
  RUNNING: 'Running',
  PAUSED: 'On break',
  FINISHED: 'Finished',
  CANCELLED: 'Cancelled',
};

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

export function TournamentDetailScreen({ navigation, route }: Props): JSX.Element {
  const { tournamentId } = route.params;
  const { data: view, isLoading, isError, refetch, isRefetching } = useTournament(tournamentId);
  const register = useRegisterTournament();
  const unregister = useUnregisterTournament();

  const enter = useCallback(
    () => navigation.navigate('TournamentTable', { tournamentId }),
    [navigation, tournamentId],
  );

  if (isError || (!view && !isLoading)) {
    return (
      <SafeAreaView style={styles.center} edges={['bottom']}>
        <EmptyState title="Couldn’t load this tournament" body="Pull to retry." />
      </SafeAreaView>
    );
  }
  if (!view) {
    return (
      <SafeAreaView style={styles.center} edges={['bottom']}>
        <Text style={styles.muted}>Loading…</Text>
      </SafeAreaView>
    );
  }

  const running = view.status === 'RUNNING' || view.status === 'PAUSED';
  const registered = view.you !== null;
  const eliminated = view.you?.eliminated ?? false;
  const entryCost = view.buyIn + view.entryFee;

  return (
    <SafeAreaView style={styles.root} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} />
        }
      >
        <View style={styles.headerRow}>
          <Text style={styles.title}>{view.name}</Text>
          <Tag label={STATUS_LABEL[view.status] ?? view.status} />
        </View>
        <Text style={styles.muted}>
          {view.gameType} · {entryCost.toLocaleString()} entry
          {view.entryFee > 0
            ? ` (${view.buyIn.toLocaleString()} + ${view.entryFee.toLocaleString()} fee)`
            : ''}
        </Text>

        {view.clock ? (
          <View style={styles.clockBlock}>
            <TournamentClock clock={view.clock} />
            <View style={styles.clockMeta}>
              <Text style={styles.muted}>
                {view.clock.playersLeft} left of {view.entrantCount} · {view.placesPaid} paid
              </Text>
              {view.clock.handForHand ? <Tag label="Hand-for-hand" tone="accent" /> : null}
            </View>
          </View>
        ) : null}

        {/* your standing */}
        <View style={styles.card}>
          <Text style={styles.cardHeading}>You</Text>
          {!registered ? (
            <Text style={styles.muted}>Not registered.</Text>
          ) : view.status === 'FINISHED' ? (
            <Text style={styles.body}>
              Finished {view.you?.finishPosition ? ordinal(view.you.finishPosition) : '—'}
              {view.you && view.you.payout > 0 ? ` · +${view.you.payout.toLocaleString()}` : ''}
            </Text>
          ) : eliminated ? (
            <Text style={styles.body}>
              Busted {view.you?.finishPosition ? ordinal(view.you.finishPosition) : ''}
            </Text>
          ) : running ? (
            <Text style={styles.body}>
              Seated · {view.you?.stack.toLocaleString()} chips
              {view.you?.tableId ? ` · table ${view.you.tableId.split(':').pop()}` : ''}
            </Text>
          ) : (
            <Text style={styles.body}>Registered · waiting for the tournament to start.</Text>
          )}

          <View style={styles.actions}>
            {!registered && view.registrationOpen ? (
              <Button
                label={
                  register.isPending ? 'Registering…' : `Register · ${entryCost.toLocaleString()}`
                }
                onPress={() => register.mutate(tournamentId)}
              />
            ) : null}
            {registered && view.canUnregister ? (
              <Button
                label={unregister.isPending ? 'Unregistering…' : 'Unregister'}
                variant="secondary"
                onPress={() => unregister.mutate(tournamentId)}
              />
            ) : null}
            {registered && running && !eliminated ? (
              <Button label="Enter table" onPress={enter} />
            ) : null}
          </View>
          {(register.isError || unregister.isError) && (
            <Text style={styles.error}>
              {(register.error ?? unregister.error) instanceof Error
                ? (register.error ?? unregister.error)!.message
                : 'Something went wrong.'}
            </Text>
          )}
        </View>

        {view.payouts.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.cardHeading}>Prize pool · {view.prizePool.toLocaleString()}</Text>
            {view.payouts.map((amount, i) => (
              <View key={i} style={styles.ladderRow}>
                <Text style={styles.ladderPlace}>{ordinal(i + 1)}</Text>
                <Text style={styles.ladderAmount}>{amount.toLocaleString()}</Text>
              </View>
            ))}
          </View>
        ) : null}

        <View style={styles.card}>
          <Text style={styles.cardHeading}>Blind structure</Text>
          <Text style={styles.muted}>Starting stack {view.startingStack.toLocaleString()}</Text>
          {view.blinds.map((lvl: BlindLevelWire) => {
            const current = view.clock?.level === lvl.level;
            return (
              <View
                key={lvl.level}
                style={[styles.levelRow, current ? styles.levelRowCurrent : null]}
              >
                <Text style={[styles.levelLabel, current ? styles.levelCurrentText : null]}>
                  {lvl.isBreak ? 'Break' : `Level ${lvl.level}`}
                </Text>
                <Text style={[styles.levelBlinds, current ? styles.levelCurrentText : null]}>
                  {lvl.isBreak
                    ? `${Math.round(lvl.durationMs / 60_000)}m`
                    : `${lvl.smallBlind}/${lvl.bigBlind}${lvl.ante ? ` (${lvl.ante})` : ''}`}
                </Text>
              </View>
            );
          })}
        </View>

        {view.results ? (
          <View style={styles.card}>
            <Text style={styles.cardHeading}>Final standings</Text>
            {view.results.slice(0, view.placesPaid || 3).map((r) => (
              <View key={r.position} style={styles.ladderRow}>
                <Text style={styles.ladderPlace}>{ordinal(r.position)}</Text>
                <Text style={styles.body}>{r.username}</Text>
                <Text style={styles.ladderAmount}>
                  {r.payout > 0 ? `+${r.payout.toLocaleString()}` : ''}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.md },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  title: { ...typography.h2, color: colors.textPrimary, flex: 1 },
  muted: { ...typography.caption, color: colors.textSecondary },
  body: { ...typography.body, color: colors.textPrimary },
  error: { ...typography.caption, color: colors.danger, marginTop: spacing.xs },
  clockBlock: { gap: spacing.sm },
  clockMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  cardHeading: { ...typography.label, color: colors.textPrimary, marginBottom: spacing.xs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  ladderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: 2,
  },
  ladderPlace: { ...typography.caption, color: colors.textSecondary, width: 44 },
  ladderAmount: {
    ...typography.body,
    color: colors.accent,
    fontVariant: ['tabular-nums'],
  },
  levelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
  },
  levelRowCurrent: { backgroundColor: colors.surfaceAlt },
  levelLabel: { ...typography.caption, color: colors.textSecondary },
  levelBlinds: {
    ...typography.caption,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums'],
  },
  levelCurrentText: { color: colors.accent, fontWeight: '600' },
});
