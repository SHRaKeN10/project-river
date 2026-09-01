import type { AuthResponse, PublicUser } from '@river/shared-types';
import { apiFetch } from './client';

export const authApi = {
  register: (input: { email: string; username: string; password: string }) =>
    apiFetch<AuthResponse>('/api/auth/register', { method: 'POST', body: input, auth: false }),

  login: (input: { emailOrUsername: string; password: string }) =>
    apiFetch<AuthResponse>('/api/auth/login', { method: 'POST', body: input, auth: false }),

  refresh: (refreshToken: string) =>
    apiFetch<{ tokens: AuthResponse['tokens'] }>('/api/auth/refresh', {
      method: 'POST',
      body: { refreshToken },
      auth: false,
    }),

  me: () => apiFetch<PublicUser>('/api/auth/me'),

  logout: () => apiFetch<void>('/api/auth/logout', { method: 'POST' }),
};

export const chipsApi = {
  balance: () => apiFetch<{ playChips: number }>('/api/chips'),
  rebuy: () => apiFetch<{ playChips: number }>('/api/chips/rebuy', { method: 'POST' }),
};
