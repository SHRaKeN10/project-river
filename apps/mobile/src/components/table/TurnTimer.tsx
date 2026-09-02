import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { colors, radius } from '../../theme/tokens';

interface Props {
  /** Epoch millis by which the acting player must act. */
  deadline: number;
}

/** A thin bar that drains from full to empty as the action clock runs out. */
export function TurnTimer({ deadline }: Props): JSX.Element {
  const spanRef = useRef<{ deadline: number; start: number; total: number }>({
    deadline: 0,
    start: 0,
    total: 1,
  });
  const [fraction, setFraction] = useState(1);

  useEffect(() => {
    const now = Date.now();
    spanRef.current = { deadline, start: now, total: Math.max(1, deadline - now) };
    setFraction(1);

    const tick = (): void => {
      const remaining = spanRef.current.deadline - Date.now();
      setFraction(Math.max(0, Math.min(1, remaining / spanRef.current.total)));
    };
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [deadline]);

  const tone = fraction < 0.25 ? colors.danger : fraction < 0.5 ? colors.warning : colors.success;

  return (
    <View style={styles.track}>
      <View style={[styles.fill, { flex: fraction, backgroundColor: tone }]} />
      <View style={{ flex: 1 - fraction }} />
    </View>
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
});
