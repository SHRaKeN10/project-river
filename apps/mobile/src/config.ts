import Constants from 'expo-constants';

interface Extra {
  apiBaseUrl?: string;
  socketUrl?: string;
}

const extra = (Constants.expoConfig?.extra ?? {}) as Extra;

/**
 * API + socket origins. On a real device `localhost` is the phone itself, so
 * set `EXPO_PUBLIC_API_URL` to your machine's LAN IP (e.g. http://192.168.1.20:3000)
 * when running `pnpm --filter @river/mobile dev`.
 */
export const config = {
  apiBaseUrl: process.env.EXPO_PUBLIC_API_URL ?? extra.apiBaseUrl ?? 'http://localhost:3000',
  socketUrl: process.env.EXPO_PUBLIC_SOCKET_URL ?? extra.socketUrl ?? 'http://localhost:3000',
} as const;
