import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { RedisService } from '../infra/redis/redis.service';

/**
 * A small Redis-backed denylist of revoked session ids (`sid`), so a
 * logged-out / password-reset / reuse-detected session's *access* token stops
 * working immediately instead of remaining valid until it expires.
 *
 * Entries self-expire after the access-token TTL - once no un-expired access
 * token could still carry that `sid`, the entry is worthless. A Redis outage
 * fails open (the token is allowed): the access-token TTL is the backstop, and
 * refresh is always checked against the database.
 */
@Injectable()
export class SessionBlocklistService {
  private readonly logger = new Logger(SessionBlocklistService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
  ) {}

  private key(sessionId: string): string {
    return `auth:sid-revoked:${sessionId}`;
  }

  async revoke(sessionId: string): Promise<void> {
    await this.revokeMany([sessionId]);
  }

  async revokeMany(sessionIds: readonly string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    const ttl = this.config.get('JWT_ACCESS_TTL');
    try {
      const pipe = this.redis.client.pipeline();
      for (const id of sessionIds) pipe.set(this.key(id), '1', 'EX', ttl);
      await pipe.exec();
    } catch (err) {
      // Non-fatal: the DB revocation already happened; access tokens still
      // expire on their own. Log loudly so the outage is visible.
      this.logger.error(
        `failed to blocklist ${sessionIds.length} session(s): ${(err as Error).message}`,
      );
    }
  }

  async isRevoked(sessionId: string): Promise<boolean> {
    try {
      return (await this.redis.client.exists(this.key(sessionId))) === 1;
    } catch (err) {
      this.logger.error(`blocklist check failed for ${sessionId}: ${(err as Error).message}`);
      return false; // fail open
    }
  }
}
