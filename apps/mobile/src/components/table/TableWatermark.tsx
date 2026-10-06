import { Image, StyleSheet, Text, View } from 'react-native';
import { GAME_TYPE_LABEL, GameType } from '@river/shared-types';
import { WATERMARK_HEIGHT, WATERMARK_TOP_FRACTION } from '../../features/table/layout';
import { colors, typography } from '../../theme/tokens';
import logo from '../../../assets/palace-poker-logo.png';

// White mark + wordmark on transparent (334x70). The "Grand Prairie" script line of
// the full lockup is left off on purpose.
const LOGO_WIDTH = 136;
const WORDMARK_SHARE = 0.78;

interface Props {
  gameType: string;
  smallBlind: number;
  bigBlind: number;
}

/** Table branding printed on the felt - the Palace Poker mark, then the
 * game and blinds, below the board. Drawn over the (see-through) seats. */
export function TableWatermark({ gameType, smallBlind, bigBlind }: Props): JSX.Element {
  const game = GAME_TYPE_LABEL[gameType as GameType] ?? gameType;
  return (
    <View style={styles.wrap} pointerEvents="none">
      <Image
        source={logo}
        style={styles.logo}
        resizeMode="contain"
        accessibilityLabel="Palace Poker"
      />
      <View style={styles.detailBlock}>
        <Text style={styles.detail}>{game}</Text>
        <Text style={styles.detail}>
          Blinds {smallBlind.toLocaleString()}/{bigBlind.toLocaleString()}
        </Text>
      </View>
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
  logo: { width: LOGO_WIDTH, height: (LOGO_WIDTH * 70) / 334, opacity: 0.7, marginBottom: -15 },
  // Centred under the wordmark, which spans the right ~78% of the logo.
  detailBlock: {
    width: LOGO_WIDTH * WORDMARK_SHARE,
    alignItems: 'center',
    transform: [{ translateX: (LOGO_WIDTH * (1 - WORDMARK_SHARE)) / 2 }],
  },
  detail: { ...typography.caption, lineHeight: 14, color: colors.textSecondary, opacity: 0.5 },
});
