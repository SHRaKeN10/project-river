import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { GAME_HOLE_CARDS, GameType, POT_LIMIT_GAME_TYPES } from '@river/shared-types';
import {
  ActionBar,
  BuyInSheet,
  CommunityBoard,
  GameDetailsSheet,
  SeatPod,
  TableMenuSheet,
} from '../components/table';
import { useChips, useRebuy } from '../features/api/queries';
import {
  heroSeat,
  isHeroTurn,
  seatPodWidth,
  seatRing,
  streetLabel,
} from '../features/table/layout';
import { useTable } from '../features/table/useTable';
import { colors, radius, spacing, typography } from '../theme/tokens';
import type { AppStackParams } from '../navigation/types';

type Props = NativeStackScreenProps<AppStackParams, 'Table'>;

export function TableScreen({ navigation, route }: Props): JSX.Element {
  const { tableId } = route.params;
  const { width, height } = useWindowDimensions();
  const chips = useChips();
  const rebuy = useRebuy();

  const { view, connected, error, feed, clearError, takeSeat, act, toggleSitOut, toggleStraddle } =
    useTable(tableId);

  const [buyInSeat, setBuyInSeat] = useState<number | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Standing up is handled by useTable's unmount cleanup, so every exit path
  // (this button, hardware back, a nav reset) behaves the same.
  const goBack = useCallback(() => navigation.goBack(), [navigation]);

  const onSit = useCallback((seatNumber: number) => setBuyInSeat(seatNumber), []);

  const confirmBuyIn = useCallback(
    async (amount: number) => {
      if (buyInSeat === null) return;
      setBusy(true);
      const err = await takeSeat(buyInSeat, amount);
      setBusy(false);
      if (!err) {
        setBuyInSeat(null);
        void chips.refetch();
      }
    },
    [buyInSeat, takeSeat, chips],
  );

  const onAct = useCallback(
    async (action: Parameters<typeof act>[0]) => {
      setBusy(true);
      await act(action);
      setBusy(false);
    },
    [act],
  );

  const onRebuy = useCallback(async () => {
    try {
      await rebuy.mutateAsync();
      await chips.refetch();
    } catch {
      // surfaced by the sheet staying open; the user can retry
    }
  }, [rebuy, chips]);

  if (!view) {
    return (
      <SafeAreaView style={styles.loading}>
        <Text style={styles.loadingText}>{connected ? 'Loading table…' : 'Connecting…'}</Text>
        <Pressable onPress={() => navigation.goBack()} hitSlop={10}>
          <Text style={styles.link}>Back to lobby</Text>
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
        <Pressable
          onPress={() => setMenuOpen(true)}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Table menu"
        >
          <Text style={styles.menuIcon}>☰</Text>
        </Pressable>
        <Pressable
          style={styles.headerCenter}
          onPress={() => setDetailsOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Game details"
        >
          <Text style={styles.tableName} numberOfLines={1}>
            {view.name} ⓘ
          </Text>
          <Text style={styles.stakes}>
            {view.smallBlind}/{view.bigBlind}
            {!connected ? ' · offline' : ''}
          </Text>
        </Pressable>
        <View style={styles.headerSpacer} />
      </View>

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
            bombPot={view.bombPot}
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
                onSit={onSit}
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
            {hero
              ? hero.status === 'SITTING_OUT'
                ? 'You are sitting out'
                : view.handId
                  ? 'Waiting for other players…'
                  : 'Waiting for the next hand…'
              : 'Tap an open seat to join'}
          </Text>
        )}
      </View>

      <BuyInSheet
        visible={buyInSeat !== null}
        seatNumber={buyInSeat}
        minBuyIn={view.minBuyIn}
        maxBuyIn={view.maxBuyIn}
        bigBlind={view.bigBlind}
        chipBalance={chips.data?.playChips ?? 0}
        busy={busy}
        rebuying={rebuy.isPending}
        onRebuy={onRebuy}
        onConfirm={confirmBuyIn}
        onClose={() => setBuyInSeat(null)}
      />

      <GameDetailsSheet visible={detailsOpen} view={view} onClose={() => setDetailsOpen(false)} />

      <TableMenuSheet
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        onGameDetails={() => setDetailsOpen(true)}
        onLeave={goBack}
        sittingOut={hero ? hero.status === 'SITTING_OUT' : null}
        onToggleSitOut={toggleSitOut}
        straddleOn={view.straddle && view.youAreSeat !== null ? view.youStraddleNext : null}
        onToggleStraddle={toggleStraddle}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  loading: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  loadingText: { ...typography.body, color: colors.textSecondary },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  headerCenter: { flex: 1, alignItems: 'center' },
  headerSpacer: { width: 28 },
  menuIcon: { ...typography.h2, color: colors.accent, width: 28 },
  tableName: { ...typography.h3, color: colors.textPrimary },
  stakes: { ...typography.caption, color: colors.textSecondary },
  link: { ...typography.label, color: colors.accent },
  errorBar: {
    backgroundColor: colors.danger,
    marginHorizontal: spacing.lg,
    borderRadius: radius.sm,
    padding: spacing.sm,
  },
  errorText: { ...typography.caption, color: '#fff', textAlign: 'center' },
  felt: {
    alignSelf: 'center',
    marginTop: spacing.sm,
    backgroundColor: colors.felt,
    borderRadius: 999,
    borderWidth: 6,
    borderColor: colors.feltRail,
    position: 'relative',
  },
  center: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  feed: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: spacing.md,
    alignItems: 'center',
  },
  feedPill: {
    maxWidth: '80%',
    backgroundColor: '#00000077',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  feedText: { ...typography.caption, color: '#ffffffe0' },
  seatWrap: { position: 'absolute', marginTop: -30 },
  bottom: { flex: 1, justifyContent: 'flex-end' },
  statusLine: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    padding: spacing.xl,
  },
});
