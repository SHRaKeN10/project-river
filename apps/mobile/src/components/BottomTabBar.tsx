import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, typography } from '../theme/tokens';

interface Props<T extends string> {
  items: { id: T; label: string; glyph: string }[];
  active: T;
  onChange: (id: T) => void;
}

/** The main navigation: one tap to any top-level area, gold bar under the
 * current one. */
export function BottomTabBar<T extends string>({ items, active, onChange }: Props<T>): JSX.Element {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
      {items.map((item) => {
        const selected = item.id === active;
        return (
          <Pressable
            key={item.id}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={item.label}
            onPress={() => onChange(item.id)}
            style={styles.tab}
          >
            <Text style={[styles.glyph, selected ? styles.on : null]}>{item.glyph}</Text>
            <Text style={[styles.label, selected ? styles.on : null]}>{item.label}</Text>
            <View style={[styles.underline, selected ? styles.underlineOn : null]} />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.goldSoft,
  },
  tab: { flex: 1, alignItems: 'center', paddingTop: spacing.sm, gap: 2 },
  glyph: { fontSize: 20, color: colors.textMuted },
  label: { ...typography.caption, color: colors.textMuted, fontWeight: '600' },
  on: { color: colors.accent },
  underline: {
    height: 3,
    width: 28,
    borderRadius: 2,
    marginTop: 4,
    backgroundColor: 'transparent',
  },
  underlineOn: { backgroundColor: colors.accent },
});
