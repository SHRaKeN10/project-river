import Constants from 'expo-constants';

interface Extra {
  apiBaseUrl?: string;
  socketUrl?: string;
}

const extra = (Constants.expoConfig?.extra ?? {}) as Extra;

// Priority: an inlined EXPO_PUBLIC_* env (local .env / eas.json), then the value
// baked into app.config.js (the deployed API by default). `localhost` is only
// ever a last resort for the jest environment, which mocks `extra` as empty.
const apiBaseUrl = process.env.EXPO_PUBLIC_API_URL ?? extra.apiBaseUrl ?? 'http://localhost:3000';
const socketUrl = process.env.EXPO_PUBLIC_SOCKET_URL ?? extra.socketUrl ?? apiBaseUrl;

/**
 * API + socket origins. On a real device `localhost` is the phone itself, so a
 * build must never resolve to it - `app.config.js` defaults both to the deployed
 * server. For local device testing put `EXPO_PUBLIC_API_URL=http://<lan-ip>:3000`
 * in `apps/mobile/.env`.
 */
export const config = { apiBaseUrl, socketUrl } as const;

/** Just the host, for an "am I pointed at the right server?" line in the UI. */
export function apiHost(): string {
  try {
    return new URL(apiBaseUrl).host;
  } catch {
    return apiBaseUrl;
  }
}

if (__DEV__) {
  // eslint-disable-next-line no-console
  console.log(`[config] api=${apiBaseUrl} socket=${socketUrl}`);
}
