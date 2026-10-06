import { StyleSheet, Text, View } from 'react-native';
import { GAME_TYPE_LABEL, GameType } from '@river/shared-types';
import { WATERMARK_HEIGHT, WATERMARK_TOP_FRACTION } from '../../features/table/layout';
import { colors, typography } from '../../theme/tokens';

interface Props {
  gameType: string;
  smallBlind: number;
  bigBlind: number;
}

/** Table branding printed on the felt - the house name in wide-set caps, then the
 * game and blinds, tucked between the top seat and the board. Sits behind the
 * board and the seats. */
export function TableWatermark({ gameType, smallBlind, bigBlind }: Props): JSX.Element {
  const game = GAME_TYPE_LABEL[gameType as GameType] ?? gameType;
  return (
    <View style={styles.wrap} pointerEvents="none">
      <Text style={styles.brand}>PALACE POKER</Text>
      <Text style={styles.detail}>{game}</Text>
      <Text style={styles.detail}>
        Blinds {smallBlind.toLocaleString()}/{bigBlind.toLocaleString()}
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
    fontSize: 12,
    letterSpacing: 3,
    fontWeight: '600',
    opacity: 0.5,
  },
  detail: { ...typography.caption, color: colors.textSecondary, opacity: 0.45 },
});
