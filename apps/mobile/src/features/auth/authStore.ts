import { create } from 'zustand';
import type { PublicUser } from '@river/shared-types';
import { ApiError, configureApi } from '../api/client';
import { authApi } from '../api/endpoints';
import { tokenStorage } from './tokenStorage';

type Status = 'loading' | 'authed' | 'guest';

interface AuthState {
  status: Status;
  user: PublicUser | null;
  accessToken: string | null;
  refreshToken: string | null;
  error: string | null;

  hydrate: () => Promise<void>;
  login: (emailOrUsername: string, password: string) => Promise<void>;
  register: (email: string, username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
  setUser: (user: PublicUser) => void;
}

let refreshInFlight: Promise<boolean> | null = null;

export const useAuthStore = create<AuthState>()((set, get) => {
  const setSession = async (
    tokens: { accessToken: string; refreshToken: string },
    user: PublicUser,
  ) => {
    await tokenStorage.save(tokens);
    set({
      status: 'authed',
      user,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      error: null,
    });
  };

  const doRefresh = async (): Promise<boolean> => {
    const current = get().refreshToken;
    if (!current) return false;
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = (async () => {
      try {
        const { tokens } = await authApi.refresh(current);
        await tokenStorage.save({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
        });
        set({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
        return true;
      } catch {
        return false;
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  };

  const forceLogout = () => {
    void tokenStorage.clear();
    set({ status: 'guest', user: null, accessToken: null, refreshToken: null });
  };

  configureApi({
    getAccessToken: () => get().accessToken,
    refresh: doRefresh,
    onAuthLost: forceLogout,
  });

  return {
    status: 'loading',
    user: null,
    accessToken: null,
    refreshToken: null,
    error: null,

    async hydrate() {
      const stored = await tokenStorage.load();
      if (!stored) {
        set({ status: 'guest' });
        return;
      }
      set({ accessToken: stored.accessToken, refreshToken: stored.refreshToken });
      try {
        const user = await authApi.me();
        set({ status: 'authed', user });
      } catch {
        forceLogout();
      }
    },

    async login(emailOrUsername, password) {
      set({ error: null });
      try {
        const res = await authApi.login({ emailOrUsername, password });
        await setSession(res.tokens, res.user);
      } catch (err) {
        set({ error: messageOf(err) });
        throw err;
      }
    },

    async register(email, username, password) {
      set({ error: null });
      try {
        const res = await authApi.register({ email, username, password });
        await setSession(res.tokens, res.user);
      } catch (err) {
        set({ error: messageOf(err) });
        throw err;
      }
    },

    async logout() {
      await authApi.logout().catch(() => undefined);
      forceLogout();
    },

    clearError() {
      set({ error: null });
    },

    setUser(user) {
      set({ user });
    },
  };
});

function messageOf(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Something went wrong. Please try again.';
}
