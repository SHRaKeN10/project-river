import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, typography } from '../../theme/tokens';

interface Props {
  visible: boolean;
  onClose: () => void;
  onGameDetails: () => void;
  onLeave: () => void;
  /** null when the viewer isn't seated (the sit-out row is then hidden). */
  sittingOut: boolean | null;
  onToggleSitOut: (sittingOut: boolean) => void;
}

/** The slide-out table menu, the way Texas Card House/Hijack organise the
 * in-table actions - a left panel rather than buttons scattered in the header. */
export function TableMenuSheet({
  visible,
  onClose,
  onGameDetails,
  onLeave,
  sittingOut,
  onToggleSitOut,
}: Props): JSX.Element {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close menu" />
      <View style={styles.panel}>
        <View style={styles.header}>
          <Text style={styles.title}>Menu</Text>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button">
            <Text style={styles.close}>✕</Text>
          </Pressable>
        </View>

        <Pressable
          style={styles.item}
          accessibilityRole="button"
          onPress={() => {
            onClose();
            onGameDetails();
          }}
        >
          <Text style={styles.itemLabel}>Game details</Text>
          <Text style={styles.chevron}>›</Text>
        </Pressable>

        {sittingOut !== null ? (
          <Pressable
            style={styles.item}
            accessibilityRole="button"
            onPress={() => {
              onToggleSitOut(!sittingOut);
              onClose();
            }}
          >
            <Text style={styles.itemLabel}>{sittingOut ? 'Sit in' : 'Sit out'}</Text>
          </Pressable>
        ) : null}

        <Pressable
          style={styles.item}
          accessibilityRole="button"
          onPress={() => {
            onClose();
            onLeave();
          }}
        >
          <Text style={[styles.itemLabel, styles.danger]}>Leave table</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000000aa' },
  panel: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: '78%',
    maxWidth: 340,
    backgroundColor: colors.surface,
    borderTopRightRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
    paddingTop: spacing.xxl,
    paddingHorizontal: spacing.lg,
    gap: spacing.xs,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: spacing.md,
  },
  title: { ...typography.h2, color: colors.textPrimary },
  close: { ...typography.h3, color: colors.textSecondary },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  itemLabel: { ...typography.body, color: colors.textPrimary },
  danger: { color: colors.danger },
  chevron: { ...typography.h3, color: colors.textMuted },
});
