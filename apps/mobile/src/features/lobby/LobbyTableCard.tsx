import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { LobbyTableView } from '@river/shared-types';
import { Button } from '../../components';
import { colors, radius, spacing, typography } from '../../theme/tokens';
import { gameBadge, stakeTierOf, STAKE_TIERS, type StakeTierId } from './filters';

interface Props {
  table: LobbyTableView;
  onOpen: (tableId: string) => void;
  onToggleFavorite: (table: LobbyTableView) => void;
  onToggleWaitlist: (table: LobbyTableView) => void;
  busy?: boolean;
}

const SPINE: Record<StakeTierId, string> = {
  low: '#4b4a45',
  mid: '#9a7f35',
  high: '#8b0000',
};

function statusOf(table: LobbyTableView): { text: string; tone: 'seated' | 'full' | 'open' } {
  if (table.youAreSeated) return { text: "You're seated", tone: 'seated' };
  if (table.openSeats === 0) {
    return {
      text: table.waitlistCount > 0 ? `Full · ${table.waitlistCount} waiting` : 'Full',
      tone: 'full',
    };
  }
  return { text: `${table.openSeats} open`, tone: 'open' };
}

function LobbyTableCardBase({
  table,
  onOpen,
  onToggleFavorite,
  onToggleWaitlist,
  busy = false,
}: Props): JSX.Element {
  const full = table.openSeats === 0;
  const tier = stakeTierOf(table.bigBlind);
  const tierLabel = STAKE_TIERS.find((t) => t.id === tier)?.label ?? '';
  const status = statusOf(table);
  const extras = [
    table.ante > 0 ? `Ante ${table.ante}` : null,
    table.timeChargeAmount > 0
      ? `Fee ${table.timeChargeAmount}/${Math.round(table.timeChargeIntervalMs / 60_000)}m`
      : null,
  ].filter(Boolean);

  return (
    <Pressable
      onPress={() => onOpen(table.id)}
      accessibilityRole="button"
      accessibilityLabel={`${table.name}, ${gameBadge(table.gameType)} ${table.smallBlind}/${table.bigBlind}, ${status.text}`}
      style={({ pressed }) => [styles.card, pressed ? styles.pressed : null]}
    >
      <View style={[styles.spine, { backgroundColor: SPINE[tier] }]}>
        <Text style={styles.spineText} numberOfLines={1}>
          {tierLabel.toUpperCase()}
        </Text>
      </View>

      <View style={styles.body}>
        <View style={styles.topRow}>
          <Text style={styles.name} numberOfLines={1}>
            {table.name}
          </Text>
          <Text style={styles.seatCount}>
            {table.seatedCount}/{table.maxSeats}
          </Text>
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

        <View style={styles.mainRow}>
          <View style={styles.col}>
            <Text style={styles.blinds}>
              {table.smallBlind}/{table.bigBlind}
            </Text>
            <Text style={styles.caption}>Blinds</Text>
          </View>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{gameBadge(table.gameType)}</Text>
          </View>
          <View style={[styles.col, styles.colRight]}>
            <Text style={styles.buyIn}>{table.minBuyIn.toLocaleString()}</Text>
            <Text style={styles.caption}>Min buy-in</Text>
          </View>
        </View>

        <View style={styles.footRow}>
          <View style={styles.dots} accessibilityElementsHidden>
            {Array.from({ length: table.maxSeats }, (_, i) => (
              <View key={i} style={[styles.dot, i < table.seatedCount ? styles.dotOn : null]} />
            ))}
          </View>
          <Text
            style={[
              styles.status,
              status.tone === 'seated' ? styles.statusSeated : null,
              status.tone === 'full' ? styles.statusFull : null,
            ]}
          >
            {status.text}
          </Text>
          {extras.length > 0 ? <Text style={styles.extras}>{extras.join(' · ')}</Text> : null}
        </View>

        {full && !table.youAreSeated ? (
          <Button
            label={table.onWaitlist ? 'Leave waitlist' : 'Join waitlist'}
            variant={table.onWaitlist ? 'ghost' : 'secondary'}
            loading={busy}
            onPress={() => onToggleWaitlist(table)}
          />
        ) : null}
      </View>
    </Pressable>
  );
}

export const LobbyTableCard = memo(LobbyTableCardBase);

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.goldSoft,
    overflow: 'hidden',
  },
  pressed: { opacity: 0.75 },
  spine: { width: 26, alignItems: 'center', justifyContent: 'center' },
  spineText: {
    width: 70,
    textAlign: 'center',
    transform: [{ rotate: '-90deg' }],
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.5,
    color: colors.textPrimary,
  },
  body: { flex: 1, padding: spacing.md, gap: spacing.sm },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { ...typography.h3, flex: 1, color: colors.textPrimary },
  seatCount: { ...typography.label, color: colors.textSecondary },
  star: { fontSize: 20, color: colors.textMuted, lineHeight: 22 },
  starOn: { color: colors.accent },
  mainRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  col: { flex: 1, gap: 1 },
  colRight: { alignItems: 'flex-end' },
  blinds: { fontSize: 22, fontWeight: '800', color: colors.accent },
  buyIn: { fontSize: 22, fontWeight: '800', color: colors.accent },
  caption: { ...typography.caption, color: colors.textMuted },
  badge: {
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    transform: [{ skewX: '-12deg' }],
  },
  badgeText: {
    ...typography.label,
    color: colors.textPrimary,
    fontWeight: '800',
    fontStyle: 'italic',
    letterSpacing: 0.5,
  },
  footRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  dots: { flexDirection: 'row', gap: 4 },
  dot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  dotOn: { backgroundColor: colors.accent },
  status: { ...typography.caption, color: colors.textSecondary, fontWeight: '600' },
  statusSeated: { color: colors.accent },
  statusFull: { color: colors.danger },
  extras: { ...typography.caption, color: colors.textMuted },
});
