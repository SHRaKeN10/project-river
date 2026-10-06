import { Platform, StyleSheet, Text, View } from 'react-native';
import { GAME_TYPE_LABEL, GameType } from '@river/shared-types';
import { WATERMARK_HEIGHT, WATERMARK_TOP_FRACTION } from '../../features/table/layout';
import { colors, typography } from '../../theme/tokens';

/** The venue line of the Palace Poker lockup. One room for now. */
export const WATERMARK_VENUE = 'Grand Prairie';

interface Props {
  gameType: string;
  smallBlind: number;
  bigBlind: number;
}

/** Table branding printed on the felt in the Palace Poker lockup - wide-set
 * caps over a script venue line - then the game and blinds. Sits behind the
 * board and the seats. */
export function TableWatermark({ gameType, smallBlind, bigBlind }: Props): JSX.Element {
  const game = GAME_TYPE_LABEL[gameType as GameType] ?? gameType;
  return (
    <View style={styles.wrap} pointerEvents="none">
      <Text style={styles.brand}>PALACE POKER</Text>
      <Text style={styles.venue}>{WATERMARK_VENUE}</Text>
      <Text style={styles.detail}>
        {game} · Blinds {smallBlind.toLocaleString()}/{bigBlind.toLocaleString()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: `${WATERMARK_TOP_FRACTION * 100}%`,
    height: WATERMARK_HEIGHT,
    alignItems: 'center',
  },
  brand: {
    ...typography.label,
    color: colors.textPrimary,
    letterSpacing: 5,
    fontWeight: '600',
    opacity: 0.5,
  },
  venue: {
    fontSize: 18,
    fontFamily: Platform.select({ ios: 'Snell Roundhand', default: 'cursive' }),
    color: colors.textPrimary,
    opacity: 0.45,
    marginTop: -1,
  },
  detail: { ...typography.caption, color: colors.textSecondary, opacity: 0.45, marginTop: 1 },
});
