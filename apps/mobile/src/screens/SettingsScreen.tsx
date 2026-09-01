import Constants from 'expo-constants';
import { StyleSheet, Text, View } from 'react-native';
import { Button, Screen } from '../components';
import { config } from '../config';
import { useAuthStore } from '../features/auth/authStore';
import { colors, spacing, typography } from '../theme/tokens';

export function SettingsScreen(): JSX.Element {
  const logout = useAuthStore((s) => s.logout);

  return (
    <Screen contentStyle={styles.content}>
      <View style={styles.info}>
        <Text style={styles.line}>Version {Constants.expoConfig?.version ?? '0.0.0'}</Text>
        <Text style={styles.line}>Server {config.apiBaseUrl}</Text>
      </View>
      <Button label="Sign out" variant="danger" onPress={() => void logout()} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { flex: 1, justifyContent: 'space-between' },
  info: { gap: spacing.xs },
  line: { ...typography.caption, color: colors.textMuted },
});
