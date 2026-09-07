import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { passwordResetRequestSchema } from '@river/shared-types';
import { Button, Screen, TextField } from '../../components';
import { authApi } from '../../features/api/endpoints';
import { colors, spacing, typography } from '../../theme/tokens';
import type { AuthStackParams } from '../../navigation/types';

type Props = NativeStackScreenProps<AuthStackParams, 'ForgotPassword'>;

export function ForgotPasswordScreen({ navigation }: Props): JSX.Element {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async () => {
    const parsed = passwordResetRequestSchema.safeParse({ email: email.trim() });
    if (!parsed.success) {
      setError('Enter the email address for your account.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      // The server always answers the same way - a failure here is a network
      // problem, not "no such account".
      await authApi.requestPasswordReset(parsed.data.email);
      setSent(true);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen scroll contentStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.title}>Forgot password</Text>
        <Text style={styles.subtitle}>
          {sent
            ? 'If that address has an account, a reset code is on its way. It expires in 30 minutes.'
            : "Enter your email and we'll send a one-time reset code."}
        </Text>
      </View>

      {sent ? (
        <View style={styles.form}>
          <Button
            label="I have a code"
            onPress={() => navigation.navigate('ResetPassword', { email: email.trim() })}
          />
          <Button label="Send another" variant="ghost" onPress={() => setSent(false)} />
        </View>
      ) : (
        <View style={styles.form}>
          <TextField
            label="Email"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            value={email}
            onChangeText={setEmail}
            onSubmitEditing={submit}
            returnKeyType="send"
            error={error}
          />
          <Button label="Send reset code" onPress={submit} loading={submitting} />
        </View>
      )}

      <View style={styles.footer}>
        <Button
          label="Back to sign in"
          variant="ghost"
          onPress={() => navigation.navigate('Login')}
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
  footer: { alignItems: 'center', gap: spacing.xs },
});
