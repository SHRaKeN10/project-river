import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { GAME_HOLE_CARDS, GameType, POT_LIMIT_GAME_TYPES } from '@river/shared-types';
import { ActionBar, CommunityBoard, SeatPod } from '../components/table';
import {
  heroSeat,
  isHeroTurn,
  seatPodWidth,
  seatRing,
  streetLabel,
} from '../features/table/layout';
import { useTable } from '../features/table/useTable';
import { TournamentClock } from '../features/tournament/TournamentClock';
import { colors, radius, spacing, typography } from '../theme/tokens';
import type { AppStackParams } from '../navigation/types';

type Props = NativeStackScreenProps<AppStackParams, 'TournamentTable'>;

/**
 * A tournament table. The same felt / seats / action bar as a cash table, but
 * sourced from `useTable` in tournament mode: the server routes state and
 * actions to the player's own table and re-routes on a balance move, so there
 * is nothing to join or leave here.
 */
export function TournamentTableScreen({ navigation, route }: Props): JSX.Element {
  const { tournamentId } = route.params;
  const { width, height } = useWindowDimensions();
  const { view, connected, error, feed, clearError, act, eliminated, finished, clock } = useTable(
    tournamentId,
    { tournament: true },
  );
  const [busy, setBusy] = useState(false);

  const onAct = useCallback(
    async (action: Parameters<typeof act>[0]) => {
      setBusy(true);
      await act(action);
      setBusy(false);
    },
    [act],
  );

  if (finished) {
    const me = finished.results.find((r) => r.position === (eliminated ?? 1));
    return (
      <SafeAreaView style={styles.loading}>
        <Text style={styles.bigLine}>Tournament over</Text>
        <Text style={styles.subLine}>
          {me ? `You finished ${me.position}${me.payout > 0 ? ` · +${me.payout}` : ''}` : ''}
        </Text>
        <Pressable onPress={() => navigation.goBack()} hitSlop={10}>
          <Text style={styles.link}>Back to tournaments</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  if (eliminated !== null && !view?.handId) {
    return (
      <SafeAreaView style={styles.loading}>
        <Text style={styles.bigLine}>You busted</Text>
        <Text style={styles.subLine}>Finished {eliminated}</Text>
        <Pressable onPress={() => navigation.goBack()} hitSlop={10}>
          <Text style={styles.link}>Back to tournaments</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  if (!view) {
    return (
      <SafeAreaView style={styles.loading}>
        <Text style={styles.subLine}>{connected ? 'Finding your table…' : 'Connecting…'}</Text>
        <Pressable onPress={() => navigation.goBack()} hitSlop={10}>
          <Text style={styles.link}>Back to tournaments</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const hero = heroSeat(view);
  const myTurn = isHeroTurn(view);
  const heroIndex = view.youAreSeat ?? 0;
  const gameType = view.gameType as GameType;
  const holeCardCount = GAME_HOLE_CARDS[gameType] ?? 2;
  const potLimit = POT_LIMIT_GAME_TYPES.has(gameType);

  const feltH = Math.min(height * 0.62, height - 220);
  const feltW = width - spacing.lg * 2;
  const podW = seatPodWidth(feltW);
  const slots = seatRing(view.maxSeats, heroIndex, feltW, podW);

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={10} accessibilityRole="button">
          <Text style={styles.menuIcon}>‹</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.tableName} numberOfLines={1}>
            {view.name}
          </Text>
          <Text style={styles.stakes}>
            {view.smallBlind}/{view.bigBlind}
            {!connected ? ' · offline' : ''}
          </Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      {clock ? (
        <View style={styles.clockStrip}>
          <TournamentClock clock={clock} variant="compact" />
          <Text style={styles.clockMeta}>
            {clock.playersLeft} left{clock.handForHand ? ' · hand-for-hand' : ''}
          </Text>
        </View>
      ) : null}

      {error ? (
        <Pressable style={styles.errorBar} onPress={clearError}>
          <Text style={styles.errorText}>{error.message}</Text>
        </Pressable>
      ) : null}

      <View style={[styles.felt, { height: feltH, width: feltW }]}>
        <View style={styles.center}>
          <CommunityBoard
            cards={view.communityCards}
            pot={view.pot}
            streetLabel={streetLabel(view.street)}
          />
        </View>

        {feed.length > 0 ? (
          <View style={styles.feed} pointerEvents="none">
            <View style={styles.feedPill}>
              <Text style={styles.feedText} numberOfLines={1}>
                {feed[feed.length - 1]?.text}
              </Text>
            </View>
          </View>
        ) : null}

        {slots.map((slot) => {
          const seat = view.seats.find((s) => s.seatNumber === slot.index);
          if (!seat) return null;
          return (
            <View
              key={slot.index}
              style={[
                styles.seatWrap,
                {
                  width: podW,
                  marginLeft: -podW / 2,
                  left: `${slot.x * 100}%`,
                  top: `${slot.y * 100}%`,
                },
              ]}
            >
              <SeatPod
                seat={seat}
                isHero={seat.seatNumber === view.youAreSeat}
                isActing={seat.seatNumber === view.actingSeat}
                isButton={seat.seatNumber === view.buttonSeat}
                actionDeadline={view.actionDeadline}
                width={podW}
                holeCardCount={holeCardCount}
              />
            </View>
          );
        })}
      </View>

      <View style={styles.bottom}>
        {myTurn && view.legalActions ? (
          <ActionBar
            options={view.legalActions}
            bigBlind={view.bigBlind}
            pot={view.pot}
            currentBet={hero?.currentBet ?? 0}
            potLimit={potLimit}
            busy={busy}
            onAct={onAct}
          />
        ) : (
          <Text style={styles.statusLine}>
            {view.youAreSeat === null
              ? 'Spectating'
              : view.handId
                ? 'Waiting for other players…'
                : 'Waiting for the next hand…'}
          </Text>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  bigLine: { ...typography.h1, color: colors.textPrimary },
  subLine: { ...typography.body, color: colors.textSecondary },
  link: { ...typography.body, color: colors.accent, marginTop: spacing.lg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  menuIcon: { ...typography.h1, color: colors.textPrimary },
  headerCenter: { flex: 1, alignItems: 'center' },
  headerSpacer: { width: 24 },
  tableName: { ...typography.h3, color: colors.textPrimary },
  stakes: { ...typography.caption, color: colors.textSecondary },
  clockStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs,
  },
  clockMeta: { ...typography.caption, color: colors.textSecondary },
  errorBar: {
    backgroundColor: colors.danger,
    marginHorizontal: spacing.lg,
    borderRadius: radius.md,
    padding: spacing.sm,
  },
  errorText: { ...typography.caption, color: colors.textPrimary, textAlign: 'center' },
  felt: {
    alignSelf: 'center',
    marginTop: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: colors.feltRail,
    backgroundColor: colors.surface,
  },
  center: { position: 'absolute', top: '38%', left: 0, right: 0, alignItems: 'center' },
  feed: { position: 'absolute', top: '8%', left: 0, right: 0, alignItems: 'center' },
  feedPill: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    maxWidth: '86%',
  },
  feedText: { ...typography.caption, color: colors.textSecondary },
  seatWrap: { position: 'absolute' },
  bottom: { padding: spacing.lg, minHeight: 96, justifyContent: 'center' },
  statusLine: { ...typography.body, color: colors.textSecondary, textAlign: 'center' },
});
