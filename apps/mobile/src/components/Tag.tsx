import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, typography } from '../theme/tokens';

type Tone = 'neutral' | 'accent' | 'success' | 'info' | 'danger';

interface Props {
  label: string;
  tone?: Tone;
}

const TONES: Record<Tone, { bg: string; fg: string }> = {
  neutral: { bg: colors.surfaceAlt, fg: colors.textSecondary },
  accent: { bg: 'rgba(232,185,35,0.15)', fg: colors.accent },
  success: { bg: 'rgba(34,197,94,0.15)', fg: colors.success },
  info: { bg: 'rgba(59,130,246,0.15)', fg: colors.info },
  danger: { bg: 'rgba(239,68,68,0.15)', fg: colors.danger },
};

export function Tag({ label, tone = 'neutral' }: Props): JSX.Element {
  const t = TONES[tone];
  return (
    <View style={[styles.tag, { backgroundColor: t.bg }]}>
      <Text style={[styles.text, { color: t.fg }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tag: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.sm,
    alignSelf: 'flex-start',
  },
  text: { ...typography.caption, fontWeight: '600' },
});
