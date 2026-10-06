import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, typography } from '../../theme/tokens';

interface Props {
  /** Epoch millis by which the acting player must act. */
  deadline: number;
}

/** Whole seconds left, rounded up so the last second reads "1s", never "0s"
 * until the clock has actually run out. */
export function secondsLeft(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** A thin bar that drains as the action clock runs out, plus the seconds left
 * on a small pill straddling the top edge of the seat pod (so the pod itself
 * doesn't grow). Render it as a direct child of the pod. */
export function TurnTimer({ deadline }: Props): JSX.Element {
  const spanRef = useRef<{ deadline: number; start: number; total: number }>({
    deadline: 0,
    start: 0,
    total: 1,
  });
  const [fraction, setFraction] = useState(1);
  const [seconds, setSeconds] = useState(() => secondsLeft(deadline, Date.now()));

  useEffect(() => {
    const now = Date.now();
    spanRef.current = { deadline, start: now, total: Math.max(1, deadline - now) };
    setFraction(1);

    const tick = (): void => {
      const t = Date.now();
      const remaining = spanRef.current.deadline - t;
      setFraction(Math.max(0, Math.min(1, remaining / spanRef.current.total)));
      setSeconds(secondsLeft(spanRef.current.deadline, t));
    };
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [deadline]);

  const tone = fraction < 0.25 ? colors.danger : fraction < 0.5 ? colors.warning : colors.success;

  return (
    <>
      <View style={styles.track}>
        <View style={[styles.fill, { flex: fraction, backgroundColor: tone }]} />
        <View style={{ flex: 1 - fraction }} />
      </View>
      <View
        pointerEvents="none"
        accessibilityLabel={`${seconds} seconds left`}
        style={[styles.pill, { borderColor: tone }]}
      >
        <Text style={[styles.pillText, { color: tone }]}>{seconds}s</Text>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: '#ffffff22',
    flexDirection: 'row',
    overflow: 'hidden',
  },
  fill: { borderRadius: radius.pill },
  pill: {
    position: 'absolute',
    top: -10,
    right: spacing.sm,
    backgroundColor: '#000000dd',
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
  },
  pillText: { ...typography.caption, fontWeight: '800', fontVariant: ['tabular-nums'] },
});
