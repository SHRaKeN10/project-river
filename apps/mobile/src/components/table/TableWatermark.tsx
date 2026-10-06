import { StyleSheet, Text, View } from 'react-native';
import { GAME_TYPE_LABEL, GameType } from '@river/shared-types';
import { colors, typography } from '../../theme/tokens';

interface Props {
  gameType: string;
  smallBlind: number;
  bigBlind: number;
}

/** Table branding printed on the felt, like a casino table layout: the house
 * name, the game and the blinds. Sits behind the board and the seats. */
export function TableWatermark({ gameType, smallBlind, bigBlind }: Props): JSX.Element {
  const game = GAME_TYPE_LABEL[gameType as GameType] ?? gameType;
  return (
    <View style={styles.wrap} pointerEvents="none">
      <Text style={styles.brand}>PALACE POKER</Text>
      <Text style={styles.game}>{game}</Text>
      <Text style={styles.blinds}>
        Blinds {smallBlind.toLocaleString()}/{bigBlind.toLocaleString()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, top: '63%', alignItems: 'center' },
  brand: {
    ...typography.label,
    color: colors.accent,
    letterSpacing: 4,
    fontWeight: '800',
    opacity: 0.55,
  },
  game: { ...typography.label, color: colors.textSecondary, opacity: 0.5, marginTop: 2 },
  blinds: { ...typography.caption, color: colors.textSecondary, opacity: 0.45 },
});
