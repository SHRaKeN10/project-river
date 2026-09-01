import { randomBytes, createHash } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@river/shared-types';
import { AppConfigService } from '../config/app-config.service';

export interface AccessTokenPayload {
  sub: string;
  role: UserRole;
  /** Session id - lets logout/refresh act on the right session without another DB round trip. */
  sid: string;
}

export interface OpaqueToken {
  /** Sent to the client. Never stored. */
  raw: string;
  /** Stored in the DB in place of `raw`. */
  hash: string;
}

/** Signs/verifies access-token JWTs and generates the opaque, hashed tokens
 * used for refresh tokens and email-verification / password-reset tokens. */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  signAccessToken(payload: AccessTokenPayload): { token: string; expiresIn: number } {
    const expiresIn = this.config.get('JWT_ACCESS_TTL');
    const token = this.jwt.sign(payload, {
      secret: this.config.get('JWT_ACCESS_SECRET'),
      expiresIn,
    });
    return { token, expiresIn };
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    try {
      return this.jwt.verify<AccessTokenPayload>(token, {
        secret: this.config.get('JWT_ACCESS_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }

  /** 256 bits of entropy, base64url-encoded - used for refresh tokens and
   * verification tokens alike. Callers store only `.hash`. */
  generateOpaqueToken(): OpaqueToken {
    const raw = randomBytes(32).toString('base64url');
    return { raw, hash: this.hashOpaqueToken(raw) };
  }

  hashOpaqueToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }
}
