import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, typography } from '../../theme/tokens';
import { PlayingCard } from './PlayingCard';

interface Props {
  /** The viewer's hole cards in wire form ("As", "Td"). Empty hides the cards. */
  cards: readonly string[];
  folded: boolean;
  /** Latest hand event ("Ana wins 300 with ..."), shown above the cards. */
  feedText?: string | null;
  size: 'md' | 'lg';
}

/** The viewer's own hand, drawn full size under the felt (a 4-5 card Omaha hand
 * is unreadable when squeezed into the seat pod), plus the latest hand event. */
export function HeroTray({ cards, folded, feedText, size }: Props): JSX.Element | null {
  if (cards.length === 0 && !feedText) return null;
  return (
    <View style={styles.tray}>
      {feedText ? (
        <View style={styles.feedPill}>
          <Text style={styles.feedText} numberOfLines={1}>
            {feedText}
          </Text>
        </View>
      ) : null}
      {cards.length > 0 ? (
        <View
          style={[styles.cards, folded ? styles.folded : null]}
          accessibilityLabel={`Your cards: ${cards.join(' ')}`}
        >
          {cards.map((c, i) => (
            <PlayingCard key={`${c}-${i}`} card={c} size={size} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Card size for the tray: large when the whole hand fits across the screen with
 * room to spare vertically, else medium. */
export function heroCardSize(
  cardCount: number,
  screenWidth: number,
  screenHeight: number,
): 'md' | 'lg' {
  const LG_WIDTH = 52;
  const GAP = 6;
  const needed = cardCount * LG_WIDTH + Math.max(0, cardCount - 1) * GAP;
  return needed <= screenWidth - spacing.lg * 2 && screenHeight >= 720 ? 'lg' : 'md';
}

const styles = StyleSheet.create({
  tray: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
  cards: { flexDirection: 'row', gap: 6 },
  folded: { opacity: 0.4 },
  feedPill: {
    maxWidth: '90%',
    backgroundColor: '#000000aa',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  feedText: { ...typography.caption, color: colors.textPrimary },
});
