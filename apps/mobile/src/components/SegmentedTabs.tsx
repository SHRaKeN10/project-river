import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, typography } from '../theme/tokens';

interface Props<T extends string> {
  items: { id: T; label: string }[];
  active: T;
  onChange: (id: T) => void;
}

/** A single-choice strip, one segment always selected (e.g. the game type). */
export function SegmentedTabs<T extends string>({
  items,
  active,
  onChange,
}: Props<T>): JSX.Element {
  return (
    <View style={styles.strip} accessibilityRole="tablist">
      {items.map((item) => {
        const selected = item.id === active;
        return (
          <Pressable
            key={item.id}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(item.id)}
            style={[styles.segment, selected ? styles.segmentActive : null]}
          >
            <Text style={[styles.label, selected ? styles.labelActive : null]}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.goldSoft,
    padding: 3,
    gap: 3,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
  },
  segmentActive: { backgroundColor: colors.accent },
  label: { ...typography.label, color: colors.textSecondary },
  labelActive: { color: colors.accentText, fontWeight: '800' },
});
