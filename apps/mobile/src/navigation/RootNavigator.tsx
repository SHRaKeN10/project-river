import { useEffect } from 'react';
import { NavigationContainer, type Theme } from '@react-navigation/native';
import { useAuthStore } from '../features/auth/authStore';
import { connectSocket, disconnectSocket } from '../features/realtime/socket';
import { colors } from '../theme/tokens';
import { SplashScreen } from '../screens/SplashScreen';
import { AuthNavigator } from './AuthNavigator';
import { AppNavigator } from './AppNavigator';

const navTheme: Theme = {
  dark: true,
  colors: {
    primary: colors.accent,
    background: colors.bg,
    card: colors.bg,
    text: colors.textPrimary,
    border: colors.border,
    notification: colors.accent,
  },
};

export function RootNavigator(): JSX.Element {
  const status = useAuthStore((s) => s.status);
  const accessToken = useAuthStore((s) => s.accessToken);
  const hydrate = useAuthStore((s) => s.hydrate);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (status === 'authed' && accessToken) {
      connectSocket(accessToken);
    } else if (status === 'guest') {
      disconnectSocket();
    }
  }, [status, accessToken]);

  if (status === 'loading') return <SplashScreen />;

  return (
    <NavigationContainer theme={navTheme}>
      {status === 'authed' ? <AppNavigator /> : <AuthNavigator />}
    </NavigationContainer>
  );
}
