import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { registerSchema } from '@river/shared-types';
import { Button, Screen, TextField } from '../../components';
import { useAuthStore } from '../../features/auth/authStore';
import { colors, spacing, typography } from '../../theme/tokens';
import type { AuthStackParams } from '../../navigation/types';

type Props = NativeStackScreenProps<AuthStackParams, 'Register'>;

export function RegisterScreen({ navigation }: Props): JSX.Element {
  const register = useAuthStore((s) => s.register);
  const serverError = useAuthStore((s) => s.error);
  const clearError = useAuthStore((s) => s.clearError);

  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = async () => {
    clearError();
    const parsed = registerSchema.safeParse({
      email: email.trim(),
      username: username.trim(),
      password,
    });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[String(issue.path[0])] = issue.message;
      setErrors(next);
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      await register(parsed.data.email, parsed.data.username, parsed.data.password);
    } catch {
      /* serverError shown from store */
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen scroll contentStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.title}>Create your account</Text>
        <Text style={styles.subtitle}>Free play chips, no real money.</Text>
      </View>

      <View style={styles.form}>
        <TextField
          label="Email"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          value={email}
          onChangeText={setEmail}
          error={errors.email}
        />
        <TextField
          label="Username"
          autoCapitalize="none"
          autoCorrect={false}
          value={username}
          onChangeText={setUsername}
          error={errors.username}
        />
        <TextField
          label="Password (10+ characters)"
          secureTextEntry
          autoComplete="new-password"
          value={password}
          onChangeText={setPassword}
          error={errors.password}
        />
        {serverError ? <Text style={styles.error}>{serverError}</Text> : null}
        <Button label="Create account" onPress={submit} loading={submitting} />
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerText}>Already have an account?</Text>
        <Button label="Sign in" variant="ghost" onPress={() => navigation.navigate('Login')} />
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
