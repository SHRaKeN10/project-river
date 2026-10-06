import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { GAME_HOLE_CARDS, GameType, POT_LIMIT_GAME_TYPES } from '@river/shared-types';
import {
  ActionBar,
  BuyInSheet,
  CommunityBoard,
  DealerButton,
  GameDetailsSheet,
  HeroTray,
  heroCardSize,
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
  const { tableId, claimSeat } = route.params;
  const { width, height } = useWindowDimensions();
  const chips = useChips();
  const rebuy = useRebuy();

  const {
    view,
    connected,
    error,
    feed,
    clearError,
    takeSeat,
    act,
    toggleSitOut,
    toggleStraddle,
    toggleRunItTwice,
  } = useTable(tableId);

  const [buyInSeat, setBuyInSeat] = useState<number | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Standing up is handled by useTable's unmount cleanup, so every exit path
  // (this button, hardware back, a nav reset) behaves the same.
  const goBack = useCallback(() => navigation.goBack(), [navigation]);

  const onSit = useCallback((seatNumber: number) => setBuyInSeat(seatNumber), []);

  // Arrived here from a waitlist "seat available" prompt: open the buy-in sheet
  // straight onto the seat held for us (once, on mount).
  const claimHandled = useRef(false);
  useEffect(() => {
    if (claimSeat !== undefined && !claimHandled.current) {
      claimHandled.current = true;
      setBuyInSeat(claimSeat);
    }
  }, [claimSeat]);

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
  const heroCards = hero?.holeCards ?? [];

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
            secondBoard={view.secondBoard}
            bombPot={view.bombPot}
          />
        </View>

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
                actionDeadline={view.actionDeadline}
                width={podW}
                holeCardCount={holeCardCount}
                hideCards={heroCards.length > 0 && seat.seatNumber === view.youAreSeat}
                onSit={onSit}
              />
            </View>
          );
        })}
        {slots.map((slot) =>
          slot.index === view.buttonSeat &&
          view.seats.some((s) => s.seatNumber === slot.index && s.userId) ? (
            <DealerButton
              key="dealer-button"
              slot={slot}
              slots={slots}
              feltWidth={feltW}
              feltHeight={feltH}
              podWidth={podW}
            />
          ) : null,
        )}
      </View>

      <View style={styles.bottom}>
        <HeroTray
          cards={heroCards}
          folded={hero?.status === 'FOLDED'}
          feedText={feed.length > 0 ? feed[feed.length - 1]?.text : null}
          size={heroCardSize(heroCards.length || holeCardCount, width, height)}
        />
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
        runItTwiceOn={view.runItTwice && view.youAreSeat !== null ? view.youRunItTwice : null}
        onToggleRunItTwice={toggleRunItTwice}
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
  seatWrap: { position: 'absolute', marginTop: -30 },
  bottom: { flex: 1, justifyContent: 'flex-end' },
  statusLine: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    padding: spacing.xl,
  },
});
