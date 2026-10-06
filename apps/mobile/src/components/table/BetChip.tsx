import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, typography } from '../../theme/tokens';
import { BET_CHIP_HEIGHT } from '../../features/table/layout';

interface Props {
  amount: number;
  /** Centre of the chip, px relative to the felt. */
  x: number;
  y: number;
  width: number;
}

/** A player's bet, shown on the felt out in front of their seat. */
function BetChipBase({ amount, x, y, width }: Props): JSX.Element {
  return (
    <View
      pointerEvents="none"
      accessibilityLabel={`Bet ${amount}`}
      style={[styles.chip, { width, left: x - width / 2, top: y - BET_CHIP_HEIGHT / 2 }]}
    >
      <ChipCoin />
      <Text style={styles.amount}>{amount.toLocaleString()}</Text>
    </View>
  );
}

export const BetChip = memo(BetChipBase);

/** The little gold coin used by bet chips and the flying chips. */
export function ChipCoin({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <View style={[styles.coin, { width: size, height: size, borderRadius: size / 2 }]}>
      <View
        style={[
          styles.coinInner,
          { width: size * 0.5, height: size * 0.5, borderRadius: size / 4 },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    position: 'absolute',
    height: BET_CHIP_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: '#000000cc',
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.pill,
  },
  coin: {
    backgroundColor: colors.accent,
    borderWidth: 1,
    borderColor: '#f1e2b0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  coinInner: { borderWidth: 1, borderColor: '#7d6a30' },
  amount: { ...typography.caption, fontWeight: '800', color: colors.textPrimary },
});
