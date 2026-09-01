import { StyleSheet, Text } from 'react-native';
import { Screen } from '../components';
import { colors, spacing, typography } from '../theme/tokens';

/** Placeholder - the live lobby list lands in STEP 7b. */
export function LobbyScreen(): JSX.Element {
  return (
    <Screen contentStyle={styles.content}>
      <Text style={styles.title}>Cash games</Text>
      <Text style={styles.body}>The live table list is coming in the next build.</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.sm, justifyContent: 'center', alignItems: 'center' },
  title: { ...typography.h2, color: colors.textPrimary },
  body: { ...typography.body, color: colors.textSecondary, textAlign: 'center' },
});
