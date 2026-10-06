import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../../theme/tokens';
import {
  DEALER_BUTTON_SIZE,
  dealerButtonPosition,
  type SeatSlot,
} from '../../features/table/layout';

interface Props {
  slot: SeatSlot;
  feltWidth: number;
  feltHeight: number;
  podWidth: number;
  /** How far the seat wrapper is shifted up (see SEAT_WRAP_RISE); 0 if unshifted. */
  seatRise?: number;
  /** Every seat on the table, so the puck can avoid the other pods. */
  slots: SeatSlot[];
}

/** The dealer puck, drawn on the felt in front of the button seat. Must be
 * rendered inside the (position: relative) felt view. */
function DealerButtonBase({
  slot,
  feltWidth,
  feltHeight,
  podWidth,
  seatRise,
  slots,
}: Props): JSX.Element {
  const { x, y } = dealerButtonPosition(slot, feltWidth, feltHeight, podWidth, seatRise, slots);
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
    backgroundColor: colors.textPrimary,
    borderWidth: 2,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  label: { fontSize: 13, fontWeight: '800', color: colors.bg },
});
