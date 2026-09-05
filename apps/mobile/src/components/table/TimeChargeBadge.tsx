import { StyleSheet, Text } from 'react-native';
import { colors, typography } from '../../theme/tokens';

interface Props {
  /** Chips taken per interval, straight from the table config. */
  amount: number;
  intervalMs: number;
}

/** A static billing-rate label ("Table fee: 63 / 15 min") - the membership-
 * club model Texas card rooms like Texas Card House/Hijack use instead of a
 * pot rake. Deliberately static: no per-seat countdown to the next charge. */
export function TimeChargeBadge({ amount, intervalMs }: Props): JSX.Element {
  const minutes = Math.round(intervalMs / 60_000);
  return (
    <Text style={styles.text}>
      Table fee: {amount} / {minutes} min
    </Text>
  );
}

const styles = StyleSheet.create({
  text: { ...typography.caption, color: colors.accent },
});
