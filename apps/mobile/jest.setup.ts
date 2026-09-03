/* eslint-disable @typescript-eslint/no-require-imports */
// RNTL v13 auto-extends Jest with its built-in matchers on first import of the
// main module; the old `/extend-expect` entrypoint was removed.
import '@testing-library/react-native';

// expo-constants: the app reads `expoConfig.extra` for API URLs.
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: {} } },
}));

// expo-secure-store: back it with an in-memory map for tests.
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    getItemAsync: jest.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
    setItemAsync: jest.fn((k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve();
    }),
    deleteItemAsync: jest.fn((k: string) => {
      store.delete(k);
      return Promise.resolve();
    }),
  };
});
