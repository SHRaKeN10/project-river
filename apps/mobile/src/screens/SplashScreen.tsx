import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { colors, spacing, typography } from '../theme/tokens';

export function SplashScreen(): JSX.Element {
  return (
    <View style={styles.container}>
      <Text style={styles.wordmark}>RIVER</Text>
      <Text style={styles.tagline}>free-to-play poker</Text>
      <ActivityIndicator color={colors.accent} style={styles.spinner} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  wordmark: { ...typography.h1, color: colors.accent, letterSpacing: 6 },
  tagline: { ...typography.caption, color: colors.textMuted, letterSpacing: 2 },
  spinner: { marginTop: spacing.xl },
});
