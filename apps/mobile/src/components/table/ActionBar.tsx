import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ActionOptionView, WirePlayerAction } from '@river/shared-types';
import { colors, radius, spacing, typography } from '../../theme/tokens';

interface Props {
  options: ActionOptionView[];
  bigBlind: number;
  pot: number;
  currentBet: number;
  /** Pot-Limit table: the raise ceiling IS the pot, so "Pot" and "Max" are the
   * same chip - show just one, and make it exact. */
  potLimit?: boolean;
  busy?: boolean;
  onAct: (action: WirePlayerAction) => void;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

export function ActionBar({
  options,
  bigBlind,
  pot,
  currentBet,
  potLimit,
  busy,
  onAct,
}: Props): JSX.Element {
  const fold = options.find((o) => o.kind === 'FOLD');
  const check = options.find((o) => o.kind === 'CHECK');
  const call = options.find((o) => o.kind === 'CALL');
  const raise = options.find((o) => o.kind === 'BET' || o.kind === 'RAISE');
  const allIn = options.find((o) => o.kind === 'ALL_IN');

  const [sizing, setSizing] = useState(false);
  const [amount, setAmount] = useState(0);

  const range = useMemo(() => {
    if (!raise) return null;
    return { min: raise.min ?? 0, max: raise.max ?? 0, kind: raise.kind as 'BET' | 'RAISE' };
  }, [raise]);

  const openSizing = (): void => {
    if (!range) return;
    setAmount(range.min);
    setSizing(true);
  };

  const callTo = call?.callAmount ?? 0;
  const fraction = (f: number): number =>
    range ? clamp(currentBet + f * (pot + callTo), range.min, range.max) : 0;

  if (sizing && range) {
    const presets: { label: string; value: number }[] = potLimit
      ? [
          { label: 'Min', value: range.min },
          { label: '½', value: fraction(0.5) },
          { label: '¾', value: fraction(0.75) },
          { label: 'Pot', value: range.max },
        ]
      : [
          { label: 'Min', value: range.min },
          { label: '½', value: fraction(0.5) },
          { label: '¾', value: fraction(0.75) },
          { label: 'Pot', value: fraction(1) },
          { label: 'Max', value: range.max },
        ];
    return (
      <View style={styles.bar}>
        <View style={styles.sizingHeader}>
          <Pressable onPress={() => setSizing(false)} hitSlop={8}>
            <Text style={styles.link}>‹ Back</Text>
          </Pressable>
          <Text style={styles.amount}>
            {range.kind === 'BET' ? 'Bet to' : 'Raise to'} {amount.toLocaleString()}
          </Text>
        </View>
        <View style={styles.presetRow}>
          {presets.map((p) => (
            <Chip
              key={p.label}
              label={p.label}
              active={amount === p.value}
              onPress={() => setAmount(p.value)}
            />
          ))}
        </View>
        <View style={styles.stepRow}>
          <Stepper
            label="−"
            onPress={() => setAmount((a) => clamp(a - bigBlind, range.min, range.max))}
          />
          <Stepper
            label="+"
            onPress={() => setAmount((a) => clamp(a + bigBlind, range.min, range.max))}
          />
          <Pressable
            style={[styles.confirm, busy ? styles.disabled : null]}
            disabled={busy}
            onPress={() => {
              onAct({ type: range.kind, amount });
              setSizing(false);
            }}
          >
            <Text style={styles.confirmText}>
              {range.kind === 'BET' ? 'Bet' : 'Raise'} {amount.toLocaleString()}
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.bar}>
      <View style={styles.mainRow}>
        {fold ? (
          <Btn tone="danger" label="Fold" busy={busy} onPress={() => onAct({ type: 'FOLD' })} />
        ) : null}
        {check ? (
          <Btn tone="neutral" label="Check" busy={busy} onPress={() => onAct({ type: 'CHECK' })} />
        ) : null}
        {call ? (
          <Btn
            tone="neutral"
            label={`Call ${(call.callAmount ?? 0).toLocaleString()}`}
            busy={busy}
            onPress={() => onAct({ type: 'CALL' })}
          />
        ) : null}
        {range ? (
          <Btn
            tone="primary"
            label={range.kind === 'BET' ? 'Bet' : 'Raise'}
            busy={busy}
            onPress={openSizing}
          />
        ) : allIn ? (
          <Btn
            tone="primary"
            label="All in"
            busy={busy}
            onPress={() => onAct({ type: 'ALL_IN' })}
          />
        ) : null}
      </View>
    </View>
  );
}

function Btn({
  label,
  tone,
  onPress,
  busy,
}: {
  label: string;
  tone: 'primary' | 'neutral' | 'danger';
  onPress: () => void;
  busy?: boolean;
}): JSX.Element {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.btn,
        styles[tone],
        pressed ? styles.pressed : null,
        busy ? styles.disabled : null,
      ]}
      disabled={busy}
      onPress={onPress}
      accessibilityRole="button"
    >
      <Text style={[styles.btnText, tone === 'neutral' ? styles.btnTextDark : null]}>{label}</Text>
    </Pressable>
  );
}

function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}): JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.sizeChip, active ? styles.sizeChipActive : null]}
      accessibilityRole="button"
    >
      <Text style={[styles.sizeChipText, active ? styles.sizeChipTextActive : null]}>{label}</Text>
    </Pressable>
  );
}

function Stepper({ label, onPress }: { label: string; onPress: () => void }): JSX.Element {
  return (
    <Pressable onPress={onPress} style={styles.stepper} accessibilityRole="button">
      <Text style={styles.stepperText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  mainRow: { flexDirection: 'row', gap: spacing.sm },
  btn: {
    flex: 1,
    minHeight: 52,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  primary: { backgroundColor: colors.accent },
  neutral: { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  danger: { backgroundColor: colors.danger },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.5 },
  btnText: { ...typography.h3, color: '#fff' },
  btnTextDark: { color: colors.textPrimary },
  sizingHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  link: { ...typography.label, color: colors.textSecondary },
  amount: { ...typography.h3, color: colors.accent },
  presetRow: { flexDirection: 'row', gap: spacing.xs },
  sizeChip: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  sizeChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  sizeChipText: { ...typography.label, color: colors.textSecondary },
  sizeChipTextActive: { color: colors.accentText },
  stepRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'stretch' },
  stepper: {
    width: 52,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperText: { ...typography.h2, color: colors.textPrimary },
  confirm: {
    flex: 1,
    minHeight: 52,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmText: { ...typography.h3, color: colors.accentText },
});
