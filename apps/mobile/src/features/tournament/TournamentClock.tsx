import { StyleSheet, Text, View } from 'react-native';
import type { TournamentClockState } from '@river/shared-types';
import { colors, radius, spacing, typography } from '../../theme/tokens';
import { blindsLabel, formatCountdown, useLevelCountdown } from './clock';

interface Props {
  clock: TournamentClockState;
  /** `compact` is a single line for list rows / the table header strip. */
  variant?: 'full' | 'compact';
}

/**
 * The blind clock. Server-authoritative snapshot in, smooth local countdown
 * out (see `useLevelCountdown`). Renders the level, the blinds, and the time
 * left; on a break it says so; on the final level it shows "Final level".
 */
export function TournamentClock({ clock, variant = 'full' }: Props): JSX.Element {
  const remaining = useLevelCountdown(clock);
  const time = remaining === null ? 'Final level' : formatCountdown(remaining);
  const heading = clock.isBreak ? 'Break' : `Level ${clock.level}`;
  const blinds = blindsLabel(clock);

  if (variant === 'compact') {
    return (
      <Text style={styles.compact} numberOfLines={1}>
        {heading} · {blinds} · {time}
      </Text>
    );
  }

  return (
    <View style={styles.card}>
      <Text style={styles.heading}>{heading}</Text>
      <Text style={styles.time}>{time}</Text>
      <Text style={styles.blinds}>{clock.isBreak ? 'Blinds unchanged' : `Blinds ${blinds}`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  compact: { ...typography.caption, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
  card: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: 'center',
    gap: spacing.xs,
  },
  heading: { ...typography.label, color: colors.accent, letterSpacing: 0.5 },
  time: {
    ...typography.h1,
    color: colors.textPrimary,
    fontVariant: ['tabular-nums'],
  },
  blinds: { ...typography.caption, color: colors.textSecondary },
});
