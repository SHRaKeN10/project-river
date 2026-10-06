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
  actionDeadline: number | null;
  /** Pod width in px (narrow screens shrink it). Defaults to the full size. */
  width?: number;
  /** Face-down cards to draw for a seat still in the hand: 2 for Hold'em
   * (default), 4 for Omaha. */
  holeCardCount?: number;
  /** Don't draw this seat's hole cards (the hero's are shown larger in the tray). */
  hideCards?: boolean;
  /** Called when an empty seat is tapped. */
  onSit?: (seatNumber: number) => void;
}

function initials(name: string | null): string {
  if (!name) return '?';
  return name.slice(0, 2).toUpperCase();
}

/** Overlap so an Omaha (4) / Big O (5) hand still fits a narrow pod; two-card
 * Hold'em hands sit apart as before. */
function tuckStyle(index: number, count: number): { marginLeft: number } | null {
  if (index === 0 || count <= 3) return null;
  return { marginLeft: count >= 5 ? -15 : -12 };
}

function SeatPodBase({
  seat,
  isHero,
  isActing,
  actionDeadline,
  width,
  holeCardCount = 2,
  hideCards = false,
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
  const faceDown = !hideCards && (seat.status === 'ACTIVE' || seat.status === 'ALL_IN');

  return (
    <View
      style={[styles.pod, sizeStyle, isActing ? styles.acting : null, folded ? styles.faded : null]}
    >
      <View style={styles.row}>
        <View style={[styles.avatar, isHero ? styles.avatarHero : null]}>
          <Text style={[styles.avatarText, isHero ? styles.avatarTextHero : null]}>
            {initials(seat.username)}
          </Text>
        </View>
        <View style={styles.info}>
          <Text style={styles.name} numberOfLines={1}>
            {seat.username}
          </Text>
          <Text style={styles.stack}>
            {sittingOut ? 'Sitting out' : seat.stack.toLocaleString()}
          </Text>
        </View>
        {seat.isStraddle ? (
          <View style={styles.straddle}>
            <Text style={styles.straddleText}>STR</Text>
          </View>
        ) : null}
      </View>

      {isActing && actionDeadline ? <TurnTimer deadline={actionDeadline} /> : null}

      {hideCards ? null : showCards ? (
        <View style={styles.cards}>
          {seat.holeCards?.map((c, i) => (
            <View key={i} style={tuckStyle(i, seat.holeCards?.length ?? 0)}>
              <PlayingCard card={c} size="sm" />
            </View>
          ))}
        </View>
      ) : faceDown ? (
        <View style={styles.cards}>
          {Array.from({ length: holeCardCount }, (_, i) => (
            <View key={i} style={tuckStyle(i, holeCardCount)}>
              <PlayingCard size="sm" />
            </View>
          ))}
        </View>
      ) : null}

      {/* Overlaid on the pod's bottom edge so a bet or status never makes the pod
          taller (a tall pod runs into the community cards). */}
      {seat.currentBet > 0 ? (
        <View style={styles.tag} pointerEvents="none">
          <Text style={styles.betText}>{seat.currentBet.toLocaleString()}</Text>
        </View>
      ) : folded ? (
        <View style={styles.tag} pointerEvents="none">
          <Text style={styles.tagText}>folded</Text>
        </View>
      ) : seat.lastAction ? (
        <View style={styles.tag} pointerEvents="none">
          <Text style={styles.tagText}>{seat.lastAction.replace(/_/g, ' ').toLowerCase()}</Text>
        </View>
      ) : null}
    </View>
  );
}

export const SeatPod = memo(SeatPodBase);

/** See-through so the felt branding shows across the pods. */
const POD_BACKGROUND = '#14110fb0';

const styles = StyleSheet.create({
  pod: {
    width: 104,
    backgroundColor: POD_BACKGROUND,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.goldSoft,
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
  acting: {
    borderColor: colors.accent,
    shadowColor: colors.accent,
    shadowOpacity: 0.7,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
  },
  faded: { opacity: 0.45 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: radius.pill,
    backgroundColor: '#2a2418',
    borderWidth: 1.5,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarHero: { backgroundColor: colors.accent },
  avatarText: { ...typography.caption, fontWeight: '700', color: colors.accent },
  avatarTextHero: { color: colors.accentText },
  info: { flex: 1, minWidth: 0 },
  name: { ...typography.caption, color: colors.textPrimary, fontWeight: '600' },
  stack: { ...typography.caption, color: colors.accent },
  straddle: {
    borderRadius: radius.pill,
    backgroundColor: colors.warning,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  straddleText: { fontSize: 9, fontWeight: '800', color: colors.bg, letterSpacing: 0.5 },
  cards: { flexDirection: 'row', gap: 3 },
  tag: {
    position: 'absolute',
    left: spacing.sm,
    bottom: -8,
    backgroundColor: '#000000cc',
    borderWidth: 1,
    borderColor: colors.goldSoft,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  betText: { ...typography.caption, color: colors.textPrimary },
  tagText: { ...typography.caption, color: colors.textSecondary },
});
