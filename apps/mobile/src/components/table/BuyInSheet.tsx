import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button } from '../Button';
import { colors, radius, spacing, typography } from '../../theme/tokens';

interface Props {
  visible: boolean;
  seatNumber: number | null;
  minBuyIn: number;
  maxBuyIn: number;
  bigBlind: number;
  chipBalance: number;
  busy?: boolean;
  onConfirm: (amount: number) => void;
  onClose: () => void;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

export function BuyInSheet({
  visible,
  seatNumber,
  minBuyIn,
  maxBuyIn,
  bigBlind,
  chipBalance,
  busy,
  onConfirm,
  onClose,
}: Props): JSX.Element {
  const ceiling = Math.min(maxBuyIn, chipBalance);
  const canAfford = chipBalance >= minBuyIn;
  const [amount, setAmount] = useState(minBuyIn);

  useEffect(() => {
    if (visible)
      setAmount(clamp(Math.min(bigBlind * 100, ceiling), minBuyIn, Math.max(minBuyIn, ceiling)));
  }, [visible, bigBlind, ceiling, minBuyIn]);

  const presets = useMemo(
    () =>
      [
        { label: '20 BB', value: bigBlind * 20 },
        { label: '50 BB', value: bigBlind * 50 },
        { label: '100 BB', value: bigBlind * 100 },
        { label: 'Max', value: ceiling },
      ].filter((p) => p.value >= minBuyIn && p.value <= ceiling),
    [bigBlind, ceiling, minBuyIn],
  );

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <Text style={styles.title}>Take seat {seatNumber !== null ? seatNumber + 1 : ''}</Text>

        {canAfford ? (
          <>
            <Text style={styles.amount}>{amount.toLocaleString()}</Text>
            <Text style={styles.hint}>
              Table {minBuyIn.toLocaleString()}–{maxBuyIn.toLocaleString()} · you have{' '}
              {chipBalance.toLocaleString()}
            </Text>

            <View style={styles.presetRow}>
              {presets.map((p) => (
                <Pressable
                  key={p.label}
                  onPress={() => setAmount(clamp(p.value, minBuyIn, ceiling))}
                  style={[styles.chip, amount === p.value ? styles.chipActive : null]}
                >
                  <Text
                    style={[styles.chipText, amount === p.value ? styles.chipTextActive : null]}
                  >
                    {p.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            <View style={styles.stepRow}>
              <Pressable
                style={styles.step}
                onPress={() => setAmount((a) => clamp(a - bigBlind * 5, minBuyIn, ceiling))}
              >
                <Text style={styles.stepText}>−</Text>
              </Pressable>
              <Pressable
                style={styles.step}
                onPress={() => setAmount((a) => clamp(a + bigBlind * 5, minBuyIn, ceiling))}
              >
                <Text style={styles.stepText}>+</Text>
              </Pressable>
            </View>

            <Button
              label={`Sit down for ${amount.toLocaleString()}`}
              loading={busy}
              onPress={() => onConfirm(amount)}
            />
          </>
        ) : (
          <>
            <Text style={styles.hint}>
              You need at least {minBuyIn.toLocaleString()} chips to sit here. Top up from your
              profile.
            </Text>
            <Button label="Close" variant="secondary" onPress={onClose} />
          </>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000000aa' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.xl,
    gap: spacing.md,
  },
  title: { ...typography.h2, color: colors.textPrimary },
  amount: { ...typography.h1, color: colors.accent },
  hint: { ...typography.caption, color: colors.textSecondary },
  presetRow: { flexDirection: 'row', gap: spacing.sm },
  chip: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { ...typography.label, color: colors.textSecondary },
  chipTextActive: { color: colors.accentText },
  stepRow: { flexDirection: 'row', gap: spacing.sm },
  step: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  stepText: { ...typography.h2, color: colors.textPrimary },
});
