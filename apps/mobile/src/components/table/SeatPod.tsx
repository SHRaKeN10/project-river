import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { PublicSeatView } from '@river/shared-types';
import { colors, radius, spacing, typography } from '../../theme/tokens';
import { PlayingCard } from './PlayingCard';
import { TurnTimer } from './TurnTimer';

interface Props {
  seat: PublicSeatView;
  isHero: boolean;
  isActing: boolean;
  isButton: boolean;
  actionDeadline: number | null;
  /** Pod width in px (narrow screens shrink it). Defaults to the full size. */
  width?: number;
  /** Called when an empty seat is tapped. */
  onSit?: (seatNumber: number) => void;
}

function initials(name: string | null): string {
  if (!name) return '?';
  return name.slice(0, 2).toUpperCase();
}

function SeatPodBase({
  seat,
  isHero,
  isActing,
  isButton,
  actionDeadline,
  width,
  onSit,
}: Props): JSX.Element {
  const sizeStyle = width ? { width } : null;
  if (!seat.userId) {
    return (
      <Pressable
        style={[styles.pod, styles.empty, sizeStyle]}
        onPress={() => onSit?.(seat.seatNumber)}
        accessibilityRole="button"
        accessibilityLabel={`Sit in seat ${seat.seatNumber + 1}`}
      >
        <Text style={styles.emptyText}>Sit</Text>
      </Pressable>
    );
  }

  const folded = seat.status === 'FOLDED';
  const sittingOut = seat.status === 'SITTING_OUT';
  const showCards = (seat.holeCards?.length ?? 0) > 0;

  return (
    <View
      style={[styles.pod, sizeStyle, isActing ? styles.acting : null, folded ? styles.faded : null]}
    >
      <View style={styles.row}>
        <View style={[styles.avatar, isHero ? styles.avatarHero : null]}>
          <Text style={styles.avatarText}>{initials(seat.username)}</Text>
        </View>
        <View style={styles.info}>
          <Text style={styles.name} numberOfLines={1}>
            {seat.username}
          </Text>
          <Text style={styles.stack}>
            {sittingOut ? 'Sitting out' : seat.stack.toLocaleString()}
          </Text>
        </View>
        {isButton ? (
          <View style={styles.button}>
            <Text style={styles.buttonText}>D</Text>
          </View>
        ) : null}
      </View>

      {isActing && actionDeadline ? <TurnTimer deadline={actionDeadline} /> : null}

      {showCards ? (
        <View style={styles.cards}>
          {seat.holeCards?.map((c, i) => (
            <PlayingCard key={i} card={c} size="sm" />
          ))}
        </View>
      ) : seat.status === 'ACTIVE' || seat.status === 'ALL_IN' ? (
        <View style={styles.cards}>
          <PlayingCard size="sm" />
          <PlayingCard size="sm" />
        </View>
      ) : null}

      {seat.currentBet > 0 ? (
        <View style={styles.bet}>
          <Text style={styles.betText}>{seat.currentBet.toLocaleString()}</Text>
        </View>
      ) : seat.lastAction && !folded ? (
        <Text style={styles.lastAction}>{seat.lastAction.replace(/_/g, ' ').toLowerCase()}</Text>
      ) : null}
      {folded ? <Text style={styles.lastAction}>folded</Text> : null}
    </View>
  );
}

export const SeatPod = memo(SeatPodBase);

const styles = StyleSheet.create({
  pod: {
    width: 104,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    gap: spacing.xs,
  },
  empty: {
    borderStyle: 'dashed',
    borderColor: colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 56,
    backgroundColor: '#ffffff0d',
  },
  emptyText: { ...typography.label, color: colors.textSecondary },
  acting: { borderColor: colors.accent },
  faded: { opacity: 0.45 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarHero: { backgroundColor: colors.accent },
  avatarText: { ...typography.caption, fontWeight: '700', color: colors.textPrimary },
  info: { flex: 1, minWidth: 0 },
  name: { ...typography.caption, color: colors.textPrimary, fontWeight: '600' },
  stack: { ...typography.caption, color: colors.accent },
  button: {
    width: 18,
    height: 18,
    borderRadius: radius.pill,
    backgroundColor: colors.textPrimary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 10, fontWeight: '800', color: colors.bg },
  cards: { flexDirection: 'row', gap: 3 },
  bet: {
    alignSelf: 'flex-start',
    backgroundColor: '#00000055',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  betText: { ...typography.caption, color: colors.textPrimary },
  lastAction: { ...typography.caption, color: colors.textMuted },
});
