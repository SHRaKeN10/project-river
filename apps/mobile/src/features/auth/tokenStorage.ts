import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const ACCESS = 'river.accessToken';
const REFRESH = 'river.refreshToken';

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * expo-secure-store is native-only. On web (dev / Expo web preview) fall back to
 * localStorage - it is not a secure store, but the web build is not a shipping
 * target and this keeps the auth flow testable there.
 */
const backend =
  Platform.OS === 'web'
    ? {
        get: (k: string): Promise<string | null> =>
          Promise.resolve(globalThis.localStorage?.getItem(k) ?? null),
        set: (k: string, v: string): Promise<void> => {
          globalThis.localStorage?.setItem(k, v);
          return Promise.resolve();
        },
        del: (k: string): Promise<void> => {
          globalThis.localStorage?.removeItem(k);
          return Promise.resolve();
        },
      }
    : {
        get: (k: string) => SecureStore.getItemAsync(k),
        set: (k: string, v: string) => SecureStore.setItemAsync(k, v),
        del: (k: string) => SecureStore.deleteItemAsync(k),
      };

export const tokenStorage = {
  async load(): Promise<StoredTokens | null> {
    try {
      const [accessToken, refreshToken] = await Promise.all([
        backend.get(ACCESS),
        backend.get(REFRESH),
      ]);
      if (!accessToken || !refreshToken) return null;
      return { accessToken, refreshToken };
    } catch {
      return null;
    }
  },

  async save(tokens: StoredTokens): Promise<void> {
    await Promise.all([
      backend.set(ACCESS, tokens.accessToken),
      backend.set(REFRESH, tokens.refreshToken),
    ]);
  },

  async clear(): Promise<void> {
    await Promise.all([backend.del(ACCESS), backend.del(REFRESH)]);
  },
};
