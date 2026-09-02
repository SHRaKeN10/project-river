import { ApiError } from '../api/client';
import { useAuthStore } from './authStore';

const mockMe = jest.fn();
jest.mock('../api/endpoints', () => ({
  authApi: {
    me: (...a: unknown[]) => mockMe(...a),
    login: jest.fn(),
    register: jest.fn(),
    logout: jest.fn().mockResolvedValue(undefined),
    refresh: jest.fn(),
  },
}));
jest.mock('./tokenStorage', () => ({
  tokenStorage: {
    load: jest.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'r' }),
    save: jest.fn().mockResolvedValue(undefined),
    clear: jest.fn().mockResolvedValue(undefined),
  },
}));

beforeEach(() => {
  mockMe.mockReset();
  useAuthStore.setState({ status: 'loading', user: null, accessToken: null, refreshToken: null });
});

describe('authStore.hydrate', () => {
  it('signs the player out only on a real auth failure (401)', async () => {
    mockMe.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'nope'));
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().status).toBe('guest');
  });

  it('keeps the session on a network error and proceeds optimistically', async () => {
    mockMe.mockRejectedValue(new TypeError('Network request failed'));
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().status).toBe('authed');
  }, 10000);

  it('adopts the profile when /me succeeds', async () => {
    mockMe.mockResolvedValue({ id: 'u1', username: 'nick' });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().status).toBe('authed');
    expect(useAuthStore.getState().user).toMatchObject({ username: 'nick' });
  });
});
