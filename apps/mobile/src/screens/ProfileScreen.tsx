import { StyleSheet, Text, View } from 'react-native';
import { Button, Screen } from '../components';
import { useChips, useRebuy } from '../features/api/queries';
import { useAuthStore } from '../features/auth/authStore';
import { colors, radius, spacing, typography } from '../theme/tokens';

export function ProfileScreen(): JSX.Element {
  const user = useAuthStore((s) => s.user);
  const chips = useChips();
  const rebuy = useRebuy();

  return (
    <Screen scroll contentStyle={styles.content}>
      <View style={styles.card}>
        <Row label="Username" value={user?.username ?? '—'} />
        <Row label="Email" value={user?.email ?? '—'} />
        <Row label="Email verified" value={user?.emailVerified ? 'Yes' : 'Not yet'} />
        <Row label="Member since" value={formatDate(user?.createdAt)} />
        <Row
          label="Play chips"
          value={chips.isLoading ? '…' : (chips.data?.playChips ?? 0).toLocaleString()}
        />
      </View>

      <Button
        label="Top up play chips"
        variant="secondary"
        loading={rebuy.isPending}
        onPress={() => rebuy.mutate()}
      />
      {rebuy.isError ? <Text style={styles.error}>Could not top up right now.</Text> : null}
    </Screen>
  );
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

const styles = StyleSheet.create({
  content: { gap: spacing.xl },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  rowLabel: { ...typography.body, color: colors.textSecondary },
  rowValue: { ...typography.body, color: colors.textPrimary, flexShrink: 1, textAlign: 'right' },
  error: { ...typography.caption, color: colors.danger },
});
