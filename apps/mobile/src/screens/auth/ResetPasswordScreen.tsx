import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { passwordResetConfirmSchema } from '@river/shared-types';
import { Button, Screen, TextField } from '../../components';
import { ApiError } from '../../features/api/client';
import { authApi } from '../../features/api/endpoints';
import { colors, spacing, typography } from '../../theme/tokens';
import type { AuthStackParams } from '../../navigation/types';

type Props = NativeStackScreenProps<AuthStackParams, 'ResetPassword'>;

export function ResetPasswordScreen({ navigation, route }: Props): JSX.Element {
  const forEmail = route.params?.email;
  const [token, setToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async () => {
    const parsed = passwordResetConfirmSchema.safeParse({
      token: token.trim(),
      newPassword,
    });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[String(issue.path[0])] = issue.message;
      setErrors(next);
      return;
    }
    setErrors({});
    setFormError(null);
    setSubmitting(true);
    try {
      await authApi.confirmPasswordReset(parsed.data);
      setDone(true);
    } catch (err) {
      setFormError(
        err instanceof ApiError && err.status === 401
          ? 'That code is invalid or has expired. Request a new one.'
          : 'Something went wrong. Try again in a moment.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <Screen scroll contentStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>Password changed</Text>
          <Text style={styles.subtitle}>
            You&apos;ve been signed out everywhere else. Sign in with your new password.
          </Text>
        </View>
        <Button label="Sign in" onPress={() => navigation.navigate('Login')} />
      </Screen>
    );
  }

  return (
    <Screen scroll contentStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.title}>Reset password</Text>
        <Text style={styles.subtitle}>
          {forEmail
            ? `Enter the code sent to ${forEmail} and choose a new password.`
            : 'Enter the code from your email and choose a new password.'}
        </Text>
      </View>

      <View style={styles.form}>
        <TextField
          label="Reset code"
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="from your email"
          value={token}
          onChangeText={setToken}
          error={errors.token}
        />
        <TextField
          label="New password (10+ characters)"
          secureTextEntry
          autoComplete="new-password"
          value={newPassword}
          onChangeText={setNewPassword}
          error={errors.newPassword}
        />
        {formError ? <Text style={styles.error}>{formError}</Text> : null}
        <Button label="Set new password" onPress={submit} loading={submitting} />
      </View>

      <View style={styles.footer}>
        <Button
          label="Need a new code?"
          variant="ghost"
          onPress={() => navigation.navigate('ForgotPassword')}
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
});
