import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useChips } from '../api/queries';
import { useAuthStore } from '../auth/authStore';
import { colors, radius, spacing, typography } from '../../theme/tokens';
import logo from '../../../assets/palace-poker-logo.png';

interface Props {
  onPressProfile: () => void;
}

/** Top bar: you (tap for your profile), the Palace Poker mark, your chips. */
export function HomeHeader({ onPressProfile }: Props): JSX.Element {
  const user = useAuthStore((s) => s.user);
  const chips = useChips();
  const name = user?.username ?? 'Player';
  const balance = chips.isLoading ? '…' : (chips.data?.playChips ?? 0).toLocaleString();

  return (
    <View style={styles.bar}>
      <Pressable
        onPress={onPressProfile}
        accessibilityRole="button"
        accessibilityLabel="Your profile"
        style={styles.who}
      >
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{name.slice(0, 2).toUpperCase()}</Text>
        </View>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
      </Pressable>

      <Image
        source={logo}
        style={styles.logo}
        resizeMode="contain"
        accessibilityLabel="Palace Poker"
      />

      <View style={styles.balance} accessibilityLabel={`Play chips ${balance}`}>
        <View style={styles.coin}>
          <Text style={styles.coinText}>$</Text>
        </View>
        <Text style={styles.balanceText}>{balance}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  who: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    backgroundColor: '#2a2418',
    borderWidth: 1.5,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { ...typography.caption, fontWeight: '800', color: colors.accent },
  name: { ...typography.label, flexShrink: 1, color: colors.textPrimary },
  logo: { width: 96, height: (96 * 70) / 334 },
  balance: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  coin: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  coinText: { fontSize: 13, fontWeight: '800', color: colors.accentText },
  balanceText: { ...typography.h3, color: colors.textPrimary },
});
