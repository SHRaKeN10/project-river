import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../../theme/tokens';
import { DEALER_BUTTON_SIZE } from '../../features/table/layout';

interface Props {
  /** Centre of the puck, px relative to the felt. */
  x: number;
  y: number;
}

/** The dealer puck, drawn on the felt in front of the button seat (see
 * `feltMarkers` for where). Must be
 * rendered inside the (position: relative) felt view. */
function DealerButtonBase({ x, y }: Props): JSX.Element {
  return (
    <View
      pointerEvents="none"
      accessibilityLabel="Dealer button"
      style={[styles.puck, { left: x - DEALER_BUTTON_SIZE / 2, top: y - DEALER_BUTTON_SIZE / 2 }]}
    >
      <Text style={styles.label}>D</Text>
    </View>
  );
}

export const DealerButton = memo(DealerButtonBase);

const styles = StyleSheet.create({
  puck: {
    position: 'absolute',
    width: DEALER_BUTTON_SIZE,
    height: DEALER_BUTTON_SIZE,
    borderRadius: DEALER_BUTTON_SIZE / 2,
    backgroundColor: colors.accent,
    borderWidth: 2,
    borderColor: '#f1e2b0',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  label: { fontSize: 13, fontWeight: '800', color: colors.accentText },
});
