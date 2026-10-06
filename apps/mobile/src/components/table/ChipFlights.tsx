import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet } from 'react-native';
import type { Flight } from '../../features/table/useChipFlights';
import {
  betChipWidth,
  placeNearSeat,
  potPoint,
  seatCentre,
  BET_CHIP_HEIGHT,
  type Point,
  type SeatSlot,
} from '../../features/table/layout';
import { ChipCoin } from './BetChip';

const FLIGHT_MS = 480;
const CHIPS_PER_FLIGHT = 3;
const STAGGER_MS = 70;
const COIN = 14;

interface Props {
  flights: Flight[];
  slots: SeatSlot[];
  /** Where each seat's bet chip currently sits (seat -> centre). */
  betSpots: Map<number, Point>;
  feltWidth: number;
  feltHeight: number;
  podWidth: number;
  seatRise?: number;
  onDone: (id: string) => void;
}

/** Draws the chips travelling between a seat, its bet spot and the pot. Purely
 * decorative: it never blocks touches. */
export function ChipFlights({
  flights,
  slots,
  betSpots,
  feltWidth,
  feltHeight,
  podWidth,
  seatRise,
  onDone,
}: Props): JSX.Element {
  const pot = potPoint(feltWidth, feltHeight);
  return (
    <>
      {flights.map((f) => {
        const slot = slots.find((s) => s.index === f.seat);
        if (!slot) return null;
        const seat = seatCentre(slot, feltWidth, feltHeight, seatRise);
        // A collect leaves from where the bet chip was; it is gone by now, so
        // re-derive that spot the same way it was first placed.
        const spot =
          betSpots.get(f.seat) ??
          placeNearSeat(slot, feltWidth, feltHeight, podWidth, seatRise ?? 30, slots, {
            size: { w: betChipWidth(f.amount), h: BET_CHIP_HEIGHT },
          });
        const [from, to] =
          f.kind === 'bet' ? [seat, spot] : f.kind === 'collect' ? [spot, pot] : [pot, seat];
        return <Flight key={f.id} flight={f} from={from} to={to} onDone={onDone} />;
      })}
    </>
  );
}

function Flight({
  flight,
  from,
  to,
  onDone,
}: {
  flight: Flight;
  from: Point;
  to: Point;
  onDone: (id: string) => void;
}): JSX.Element {
  const progress = useRef(
    Array.from({ length: CHIPS_PER_FLIGHT }, () => new Animated.Value(0)),
  ).current;

  useEffect(() => {
    const runs = progress.map((v, i) =>
      Animated.timing(v, {
        toValue: 1,
        duration: FLIGHT_MS,
        delay: flight.delay + i * STAGGER_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    );
    Animated.parallel(runs).start(({ finished }) => {
      if (finished) onDone(flight.id);
    });
    return () => progress.forEach((v) => v.stopAnimation());
  }, [flight.id, flight.delay, progress, onDone]);

  return (
    <>
      {progress.map((v, i) => (
        <Animated.View
          key={i}
          pointerEvents="none"
          style={[
            styles.coin,
            {
              left: from.x - COIN / 2,
              top: from.y - COIN / 2,
              opacity: v.interpolate({
                inputRange: [0, 0.05, 0.85, 1],
                outputRange: [0, 1, 1, flight.kind === 'bet' ? 0 : 0.4],
              }),
              transform: [
                {
                  translateX: v.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, to.x - from.x],
                  }),
                },
                {
                  translateY: v.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, to.y - from.y],
                  }),
                },
                {
                  scale: v.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.8, 1.15, 0.9] }),
                },
              ],
            },
          ]}
        >
          <ChipCoin size={COIN} />
        </Animated.View>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  coin: { position: 'absolute' },
});
