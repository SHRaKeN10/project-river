import { StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Button, Screen } from '../components';
import { useChips } from '../features/api/queries';
import { useAuthStore } from '../features/auth/authStore';
import { colors, radius, spacing, typography } from '../theme/tokens';
import type { AppStackParams } from '../navigation/types';

type Props = NativeStackScreenProps<AppStackParams, 'Home'>;

export function HomeScreen({ navigation }: Props): JSX.Element {
  const user = useAuthStore((s) => s.user);
  const chips = useChips();

  return (
    <Screen scroll contentStyle={styles.content}>
      <View>
        <Text style={styles.hello}>Hey {user?.username ?? 'player'}</Text>
        <Text style={styles.sub}>Ready to play?</Text>
      </View>

      <View style={styles.balanceCard}>
        <Text style={styles.balanceLabel}>Play chips</Text>
        <Text style={styles.balanceValue}>
          {chips.isLoading ? '…' : (chips.data?.playChips ?? 0).toLocaleString()}
        </Text>
      </View>

      <View style={styles.actions}>
        <Button label="Browse cash games" onPress={() => navigation.navigate('Lobby')} />
        <Button label="Tournaments" onPress={() => navigation.navigate('Tournaments')} />
        <Button
          label="Profile"
          variant="secondary"
          onPress={() => navigation.navigate('Profile')}
        />
        <Button label="Settings" variant="ghost" onPress={() => navigation.navigate('Settings')} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.xxl },
  hello: { ...typography.h1, color: colors.textPrimary },
  sub: { ...typography.body, color: colors.textSecondary },
  balanceCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
    gap: spacing.xs,
  },
  balanceLabel: { ...typography.label, color: colors.textMuted, letterSpacing: 1 },
  balanceValue: { ...typography.h1, color: colors.accent },
  actions: { gap: spacing.md },
});
