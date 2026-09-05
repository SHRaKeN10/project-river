import { useEffect, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { colors, typography } from '../../theme/tokens';

interface Props {
  /** Chips taken per interval - just for display, the server owns the charge itself. */
  amount: number;
  /** Epoch millis of this seat's next charge. */
  nextChargeAt: number;
}

/** The membership-club billing readout ("Table fee 5 in 12:34") that stands in
 * for a pot rake - mirrors how Texas card rooms like Texas Card House/Hijack
 * bill by time instead of taking a cut of the pot. */
export function TimeChargeBadge({ amount, nextChargeAt }: Props): JSX.Element {
  const [remainingMs, setRemainingMs] = useState(() => Math.max(0, nextChargeAt - Date.now()));

  useEffect(() => {
    const tick = (): void => setRemainingMs(Math.max(0, nextChargeAt - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [nextChargeAt]);

  const totalSeconds = Math.ceil(remainingMs / 1000);
  const mm = Math.floor(totalSeconds / 60);
  const ss = totalSeconds % 60;

  return (
    <Text style={styles.text}>
      Table fee {amount} in {mm}:{ss.toString().padStart(2, '0')}
    </Text>
  );
}

const styles = StyleSheet.create({
  text: { ...typography.caption, color: colors.accent },
});
