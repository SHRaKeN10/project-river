import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { LobbyTableView } from '@river/shared-types';
import { Button, Card, Tag } from '../../components';
import { colors, spacing, typography } from '../../theme/tokens';

interface Props {
  table: LobbyTableView;
  onOpen: (tableId: string) => void;
  onToggleFavorite: (table: LobbyTableView) => void;
  onToggleWaitlist: (table: LobbyTableView) => void;
  busy?: boolean;
}

function LobbyTableCardBase({
  table,
  onOpen,
  onToggleFavorite,
  onToggleWaitlist,
  busy = false,
}: Props): JSX.Element {
  const full = table.openSeats === 0;

  return (
    <Card onPress={() => onOpen(table.id)} style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.titleBlock}>
          <Text style={styles.name} numberOfLines={1}>
            {table.name}
          </Text>
          <Text style={styles.stakes}>
            {table.gameType === 'PLO' ? 'PLO · ' : ''}
            {table.smallBlind}/{table.bigBlind}
            {table.ante > 0 ? ` · ante ${table.ante}` : ''} · {table.maxSeats}-max
            {table.timeChargeAmount > 0
              ? ` · fee ${table.timeChargeAmount}/${Math.round(table.timeChargeIntervalMs / 60_000)}m`
              : ''}
          </Text>
        </View>
        <Pressable
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={table.isFavorite ? 'Remove favourite' : 'Add favourite'}
          onPress={() => onToggleFavorite(table)}
        >
          <Text style={[styles.star, table.isFavorite ? styles.starOn : null]}>
            {table.isFavorite ? '★' : '☆'}
          </Text>
        </Pressable>
      </View>

      <View style={styles.statsRow}>
        <Stat label="Players" value={`${table.seatedCount}/${table.maxSeats}`} />
        <Stat label="Avg pot" value={table.avgPot > 0 ? table.avgPot.toLocaleString() : '—'} />
        <Stat label="Buy-in" value={`${table.minBuyIn}–${table.maxBuyIn}`} />
      </View>

      <View style={styles.tagRow}>
        {table.handInProgress ? <Tag label="Hand in play" tone="success" /> : null}
        {full ? <Tag label="Full" tone="danger" /> : <Tag label={`${table.openSeats} open`} />}
        {table.waitlistCount > 0 ? (
          <Tag label={`Waitlist ${table.waitlistCount}`} tone="info" />
        ) : null}
        {table.youAreSeated ? <Tag label="Seated" tone="accent" /> : null}
      </View>

      {full && !table.youAreSeated ? (
        <View style={styles.action}>
          <Button
            label={table.onWaitlist ? 'Leave waitlist' : 'Join waitlist'}
            variant={table.onWaitlist ? 'ghost' : 'secondary'}
            loading={busy}
            onPress={() => onToggleWaitlist(table)}
          />
        </View>
      ) : null}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

export const LobbyTableCard = memo(LobbyTableCardBase);

const styles = StyleSheet.create({
  card: { gap: spacing.md },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  titleBlock: { flex: 1, gap: 2 },
  name: { ...typography.h3, color: colors.textPrimary },
  stakes: { ...typography.caption, color: colors.textSecondary },
  star: { fontSize: 22, color: colors.textMuted, lineHeight: 24 },
  starOn: { color: colors.accent },
  statsRow: { flexDirection: 'row', gap: spacing.lg },
  stat: { gap: 2 },
  statLabel: { ...typography.caption, color: colors.textMuted },
  statValue: { ...typography.label, color: colors.textPrimary },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  action: { marginTop: spacing.xs },
});
