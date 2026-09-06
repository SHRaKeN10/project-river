import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { GAME_TYPE_LABEL, GameType, type TableStateView } from '@river/shared-types';
import { colors, radius, spacing, typography } from '../../theme/tokens';

function gameLabel(gameType: string): string {
  return GAME_TYPE_LABEL[gameType as GameType] ?? gameType;
}

interface Props {
  visible: boolean;
  view: TableStateView;
  onClose: () => void;
}

/** Read-only table config, the way Texas Card House/Hijack surface it - the
 * time charge ("Fees / interval") lives here, not on the table itself. */
export function GameDetailsSheet({ visible, view, onClose }: Props): JSX.Element {
  const rows: [string, string][] = [
    ['Game', gameLabel(view.gameType)],
    ['Stakes', `${view.smallBlind}/${view.bigBlind}`],
    ['Buy-in', `${view.minBuyIn.toLocaleString()}–${view.maxBuyIn.toLocaleString()}`],
    ['Max players', String(view.maxSeats)],
  ];
  if (view.timeChargeAmount > 0) {
    rows.push([
      'Fees / interval',
      `${view.timeChargeAmount} / ${Math.round(view.timeChargeIntervalMs / 60_000)} min`,
    ]);
  }
  if (view.runItTwice) rows.push(['Run it twice', 'Available']);
  if (view.antiRatholeMinutes > 0) {
    rows.push([
      'Re-buy policy',
      `Return with your leaving stack for ${view.antiRatholeMinutes} min`,
    ]);
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.header}>
          <Text style={styles.title}>Game details</Text>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button">
            <Text style={styles.close}>✕</Text>
          </Pressable>
        </View>
        <View style={styles.card}>
          {rows.map(([label, value], i) => (
            <View key={label} style={[styles.row, i > 0 ? styles.rowDivider : null]}>
              <Text style={styles.label}>{label}</Text>
              <Text style={styles.value}>{value}</Text>
            </View>
          ))}
        </View>
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
    gap: spacing.lg,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { ...typography.h2, color: colors.textPrimary },
  close: { ...typography.h3, color: colors.textSecondary },
  card: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
  },
  rowDivider: { borderTopWidth: 1, borderTopColor: colors.border },
  label: { ...typography.body, color: colors.textSecondary },
  value: { ...typography.body, fontWeight: '600', color: colors.textPrimary },
});
