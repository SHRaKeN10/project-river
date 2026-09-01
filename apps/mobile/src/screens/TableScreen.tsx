import { StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Button } from '../components';
import { colors, spacing, typography } from '../theme/tokens';
import type { AppStackParams } from '../navigation/types';

type Props = NativeStackScreenProps<AppStackParams, 'Table'>;

/** Placeholder - the real poker table UI lands in STEP 7c. */
export function TableScreen({ navigation, route }: Props): JSX.Element {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Table</Text>
      <Text style={styles.body}>{route.params.tableId}</Text>
      <Button label="Back to lobby" variant="secondary" onPress={() => navigation.goBack()} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.felt,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    padding: spacing.xl,
  },
  title: { ...typography.h2, color: colors.textPrimary },
  body: { ...typography.caption, color: colors.textSecondary },
});
