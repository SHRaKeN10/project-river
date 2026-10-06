import { StyleSheet, Text, View } from 'react-native';
import { colors, radius } from '../../theme/tokens';

interface Props {
  /** Wire form: "As", "Td", "9h". Omit / null for a face-down card. */
  card?: string | null;
  size?: 'sm' | 'md' | 'lg';
}

const SUIT_GLYPH: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RED = new Set(['h', 'd']);

export const DIMENSIONS = {
  sm: { w: 26, h: 36, rank: 13, suit: 11 },
  md: { w: 40, h: 56, rank: 18, suit: 16 },
  lg: { w: 52, h: 72, rank: 24, suit: 20 },
} as const;

export function PlayingCard({ card, size = 'md' }: Props): JSX.Element {
  const d = DIMENSIONS[size];

  if (!card) {
    const diamond = Math.round(d.w * 0.34);
    return (
      <View style={[styles.back, { width: d.w, height: d.h }]} accessibilityLabel="Face-down card">
        <View style={styles.backFrame} />
        <View style={[styles.backDiamond, { width: diamond, height: diamond }]} />
      </View>
    );
  }

  const rank = card.slice(0, -1).replace('T', '10');
  const suit = card.slice(-1).toLowerCase();
  const color = RED.has(suit) ? styles.red : styles.black;

  return (
    <View style={[styles.card, { width: d.w, height: d.h }]}>
      <Text style={[styles.rank, color, { fontSize: d.rank }]}>{rank}</Text>
      <Text style={[styles.suit, color, { fontSize: d.suit }]}>{SUIT_GLYPH[suit] ?? '?'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.cardFace,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.cardEdge,
    alignItems: 'center',
    justifyContent: 'center',
  },
  back: {
    backgroundColor: colors.cardBack,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backFrame: {
    position: 'absolute',
    top: 2,
    left: 2,
    right: 2,
    bottom: 2,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: '#c2a15288',
  },
  backDiamond: { backgroundColor: colors.accent, transform: [{ rotate: '45deg' }], opacity: 0.9 },
  rank: { fontWeight: '800', lineHeight: undefined },
  suit: { fontWeight: '700', marginTop: -2 },
  red: { color: colors.suitRed },
  black: { color: colors.suitBlack },
});
