import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, typography } from '../../theme/tokens';
import { PlayingCard } from './PlayingCard';

interface Props {
  cards: string[];
  pot: number;
  streetLabel: string;
  /** The second board when the hand ran twice (ADR-0028); empty otherwise. */
  secondBoard?: string[];
  /** Bomb-pot state for this table (ADR-0026). `null` when the table doesn't
   * run bomb pots. Shows a banner during a bomb-pot hand so the missing preflop
   * round is obvious. */
  bombPot?: { active: boolean; amount: number; nextInHands: number } | null;
}

function boardRow(cards: string[], key: string): JSX.Element {
  return (
    <View style={styles.cards} key={key}>
      {Array.from({ length: 5 }).map((_, i) =>
        cards[i] ? (
          <PlayingCard key={i} card={cards[i]} size="md" />
        ) : (
          <View key={i} style={styles.slot} />
        ),
      )}
    </View>
  );
}

export function CommunityBoard({
  cards,
  pot,
  streetLabel,
  secondBoard = [],
  bombPot,
}: Props): JSX.Element {
  const twoBoards = secondBoard.length > 0;
  return (
    <View style={styles.wrap}>
      {bombPot?.active ? (
        <View style={styles.bombBanner}>
          <Text style={styles.bombTitle}>💣 BOMB POT</Text>
          <Text style={styles.bombSub}>
            Everyone posted {bombPot.amount.toLocaleString()} · no preflop betting
          </Text>
        </View>
      ) : null}
      {twoBoards ? <Text style={styles.ritLabel}>RUNNING IT TWICE</Text> : null}
      {boardRow(cards, 'board1')}
      {twoBoards ? boardRow(secondBoard, 'board2') : null}
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
  bombBanner: {
    alignItems: 'center',
    gap: 2,
    backgroundColor: '#00000066',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.warning,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  bombTitle: { ...typography.label, color: colors.warning, letterSpacing: 1.5 },
  bombSub: { ...typography.caption, color: colors.textSecondary },
  ritLabel: { ...typography.caption, color: colors.accent, letterSpacing: 1.5, fontWeight: '700' },
});
