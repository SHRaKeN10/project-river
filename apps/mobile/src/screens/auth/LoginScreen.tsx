import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { loginSchema } from '@river/shared-types';
import { Button, Screen, TextField } from '../../components';
import { useAuthStore } from '../../features/auth/authStore';
import { colors, spacing, typography } from '../../theme/tokens';
import type { AuthStackParams } from '../../navigation/types';

type Props = NativeStackScreenProps<AuthStackParams, 'Login'>;

export function LoginScreen({ navigation }: Props): JSX.Element {
  const login = useAuthStore((s) => s.login);
  const serverError = useAuthStore((s) => s.error);
  const clearError = useAuthStore((s) => s.clearError);

  const [emailOrUsername, setEmailOrUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const submit = async () => {
    clearError();
    const parsed = loginSchema.safeParse({ emailOrUsername, password });
    if (!parsed.success) {
      setFieldError('Enter your username/email and password.');
      return;
    }
    setFieldError(null);
    setSubmitting(true);
    try {
      await login(emailOrUsername.trim(), password);
    } catch {
      /* serverError is shown from the store */
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen scroll contentStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.title}>Welcome back</Text>
        <Text style={styles.subtitle}>Sign in to take your seat.</Text>
      </View>

      <View style={styles.form}>
        <TextField
          label="Email or username"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username"
          value={emailOrUsername}
          onChangeText={setEmailOrUsername}
        />
        <TextField
          label="Password"
          secureTextEntry
          autoComplete="current-password"
          value={password}
          onChangeText={setPassword}
          onSubmitEditing={submit}
          returnKeyType="go"
        />
        {(fieldError ?? serverError) ? (
          <Text style={styles.error}>{fieldError ?? serverError}</Text>
        ) : null}
        <Button label="Sign in" onPress={submit} loading={submitting} />
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerText}>New here?</Text>
        <Button
          label="Create an account"
          variant="ghost"
          onPress={() => navigation.navigate('Register')}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.xxl, justifyContent: 'center' },
  header: { gap: spacing.xs },
  title: { ...typography.h1, color: colors.textPrimary },
  subtitle: { ...typography.body, color: colors.textSecondary },
  form: { gap: spacing.lg },
  error: { ...typography.caption, color: colors.danger },
  footer: { alignItems: 'center', gap: spacing.xs },
  footerText: { ...typography.caption, color: colors.textMuted },
});
