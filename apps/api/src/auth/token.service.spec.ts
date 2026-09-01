import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@river/shared-types';
import type { AppConfigService } from '../config/app-config.service';
import { TokenService } from './token.service';

function fakeConfig(overrides: Record<string, unknown> = {}): AppConfigService {
  const values: Record<string, unknown> = {
    JWT_ACCESS_SECRET: 'test-access-secret-min-16-chars',
    JWT_ACCESS_TTL: 600,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as AppConfigService;
}

describe('TokenService', () => {
  it('signs and verifies an access token round-trip', () => {
    const service = new TokenService(new JwtService(), fakeConfig());
    const { token, expiresIn } = service.signAccessToken({
      sub: 'user-1',
      role: UserRole.PLAYER,
      sid: 'session-1',
    });
    expect(expiresIn).toBe(600);

    const payload = service.verifyAccessToken(token);
    expect(payload.sub).toBe('user-1');
    expect(payload.role).toBe(UserRole.PLAYER);
    expect(payload.sid).toBe('session-1');
  });

  it('rejects a token signed with a different secret', () => {
    const signer = new TokenService(
      new JwtService(),
      fakeConfig({ JWT_ACCESS_SECRET: 'secret-a-min-16-chars' }),
    );
    const verifier = new TokenService(
      new JwtService(),
      fakeConfig({ JWT_ACCESS_SECRET: 'secret-b-min-16-chars' }),
    );
    const { token } = signer.signAccessToken({ sub: 'user-1', role: UserRole.PLAYER, sid: 's1' });
    expect(() => verifier.verifyAccessToken(token)).toThrow(UnauthorizedException);
  });

  it('rejects garbage input', () => {
    const service = new TokenService(new JwtService(), fakeConfig());
    expect(() => service.verifyAccessToken('not-a-jwt')).toThrow(UnauthorizedException);
  });

  it('generates opaque tokens with matching, deterministic hashes', () => {
    const service = new TokenService(new JwtService(), fakeConfig());
    const a = service.generateOpaqueToken();
    const b = service.generateOpaqueToken();

    expect(a.raw).not.toEqual(b.raw);
    expect(a.hash).not.toEqual(b.hash);
    expect(service.hashOpaqueToken(a.raw)).toBe(a.hash);
    expect(service.hashOpaqueToken(a.raw)).toBe(service.hashOpaqueToken(a.raw));
  });
});
