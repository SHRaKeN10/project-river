import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, typography } from '../../theme/tokens';
import { PlayingCard } from './PlayingCard';

interface Props {
  cards: string[];
  pot: number;
  streetLabel: string;
}

export function CommunityBoard({ cards, pot, streetLabel }: Props): JSX.Element {
  return (
    <View style={styles.wrap}>
      <View style={styles.cards}>
        {Array.from({ length: 5 }).map((_, i) =>
          cards[i] ? (
            <PlayingCard key={i} card={cards[i]} size="md" />
          ) : (
            <View key={i} style={styles.slot} />
          ),
        )}
      </View>
      <View style={styles.potRow}>
        <Text style={styles.street}>{streetLabel}</Text>
        {pot > 0 ? (
          <View style={styles.potChip}>
            <Text style={styles.potText}>Pot {pot.toLocaleString()}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: spacing.sm },
  cards: { flexDirection: 'row', gap: spacing.xs, minHeight: 56 },
  slot: {
    width: 40,
    height: 56,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: '#ffffff1f',
    backgroundColor: '#00000022',
  },
  potRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  street: { ...typography.caption, color: colors.textSecondary, letterSpacing: 1 },
  potChip: {
    backgroundColor: '#00000055',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  potText: { ...typography.label, color: colors.accent },
});
