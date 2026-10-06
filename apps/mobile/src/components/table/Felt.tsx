import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { colors, spacing } from '../../theme/tokens';

interface Props {
  width: number;
  height: number;
  children: ReactNode;
}

/** The cash-table felt in Palace Poker colours: black baize with a soft
 * burgundy spotlight under the board, a gold hairline inset and a two-tone gold
 * rail. The children are positioned against the full felt box. */
export function Felt({ width, height, children }: Props): JSX.Element {
  return (
    <View style={[styles.felt, { width, height }]}>
      <View pointerEvents="none" style={styles.glowWide} />
      <View pointerEvents="none" style={styles.glowMid} />
      <View pointerEvents="none" style={styles.glowCore} />
      <View pointerEvents="none" style={styles.railInner} />
      <View pointerEvents="none" style={styles.inset} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  felt: {
    alignSelf: 'center',
    marginTop: spacing.sm,
    backgroundColor: colors.felt,
    borderRadius: 999,
    borderWidth: 6,
    borderColor: colors.feltRail,
    position: 'relative',
  },
  // Stepped ellipses read as a soft spotlight without needing a gradient library.
  glowWide: {
    position: 'absolute',
    left: '8%',
    right: '8%',
    top: '14%',
    bottom: '14%',
    borderRadius: 999,
    backgroundColor: '#8b000010',
  },
  glowMid: {
    position: 'absolute',
    left: '18%',
    right: '18%',
    top: '24%',
    bottom: '24%',
    borderRadius: 999,
    backgroundColor: '#8b000016',
  },
  glowCore: {
    position: 'absolute',
    left: '28%',
    right: '28%',
    top: '34%',
    bottom: '34%',
    borderRadius: 999,
    backgroundColor: '#8b00001c',
  },
  railInner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: colors.feltRailInner,
  },
  inset: {
    position: 'absolute',
    top: 10,
    left: 10,
    right: 10,
    bottom: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#c2a15230',
  },
});
