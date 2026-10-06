import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { GAME_HOLE_CARDS, GameType, POT_LIMIT_GAME_TYPES } from '@river/shared-types';
import {
  ActionBar,
  BuyInSheet,
  CommunityBoard,
  BetChip,
  ChipFlights,
  DealerButton,
  Felt,
  GameDetailsSheet,
  HeroTray,
  heroCardSize,
  SeatPod,
  TableWatermark,
  TableMenuSheet,
} from '../components/table';
import { useChips, useRebuy } from '../features/api/queries';
import {
  feltMarkers,
  heroSeat,
  isHeroTurn,
  seatPodWidth,
  seatRing,
  streetLabel,
} from '../features/table/layout';
import { useChipFlights } from '../features/table/useChipFlights';
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
  const { flights, done: flightDone } = useChipFlights(view);

  const [buyInSeat, setBuyInSeat] = useState<number | null>(null);
  const [buyInError, setBuyInError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Standing up is handled by useTable's unmount cleanup, so every exit path
  // (this button, hardware back, a nav reset) behaves the same.
  const goBack = useCallback(() => navigation.goBack(), [navigation]);

  const onSit = useCallback((seatNumber: number) => {
    setBuyInError(null);
    setBuyInSeat(seatNumber);
  }, []);

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
      setBuyInError(null);
      const err = await takeSeat(buyInSeat, amount);
      setBusy(false);
      if (err) {
        // Keep the sheet open and say why (it used to fail silently).
        setBuyInError(err);
      } else {
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
  const markers = feltMarkers({
    slots,
    buttonSeat: view.seats.some((s) => s.seatNumber === view.buttonSeat && s.userId)
      ? view.buttonSeat
      : null,
    bets: view.seats
      .filter((s) => s.userId && s.currentBet > 0)
      .map((s) => ({ seat: s.seatNumber, amount: s.currentBet })),
    feltWidth: feltW,
    feltHeight: feltH,
    podWidth: podW,
    seatRise: 30,
  });
  const betSpots = new Map(markers.bets.map((b) => [b.seat, { x: b.x, y: b.y }]));

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

      <Felt width={feltW} height={feltH}>
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
                revealSide={slot.x < 0.4 ? 'right' : slot.x > 0.6 ? 'left' : 'center'}
                onSit={onSit}
              />
            </View>
          );
        })}
        {/* Over the seats, which are see-through, so the branding reads across them. */}
        <TableWatermark
          gameType={view.gameType}
          smallBlind={view.smallBlind}
          bigBlind={view.bigBlind}
        />
        {markers.puck ? <DealerButton x={markers.puck.x} y={markers.puck.y} /> : null}
        {markers.bets.map((b) => (
          <BetChip key={`bet-${b.seat}`} amount={b.amount} x={b.x} y={b.y} width={b.width} />
        ))}
        <ChipFlights
          flights={flights}
          slots={slots}
          betSpots={betSpots}
          feltWidth={feltW}
          feltHeight={feltH}
          podWidth={podW}
          seatRise={30}
          onDone={flightDone}
        />
      </Felt>

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
        error={buyInError}
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
