import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { colors } from '../theme/tokens';
import { HomeScreen } from '../screens/HomeScreen';
import { TableScreen } from '../screens/TableScreen';
import { TournamentDetailScreen } from '../screens/TournamentDetailScreen';
import { TournamentTableScreen } from '../screens/TournamentTableScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import type { AppStackParams } from './types';

const Stack = createNativeStackNavigator<AppStackParams>();

export function AppNavigator(): JSX.Element {
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.textPrimary,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="Home" component={HomeScreen} options={{ headerShown: false }} />
      <Stack.Screen
        name="TournamentDetail"
        component={TournamentDetailScreen}
        options={{ title: 'Tournament' }}
      />
      <Stack.Screen
        name="Table"
        component={TableScreen}
        options={{ headerShown: false, orientation: 'portrait' }}
      />
      <Stack.Screen
        name="TournamentTable"
        component={TournamentTableScreen}
        options={{ headerShown: false, orientation: 'portrait' }}
      />
      <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
    </Stack.Navigator>
  );
}
