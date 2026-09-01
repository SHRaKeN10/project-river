import { Injectable } from '@nestjs/common';
import { RedisService } from '../../infra/redis/redis.service';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets. */
  retryAfterSeconds: number;
}

/**
 * Fixed-window rate limiter backed by Redis (shared across every API
 * instance, unlike an in-memory counter). Good enough for auth endpoints at
 * MVP scale; swap for a sliding-window/token-bucket Lua script later without
 * changing call sites - `consume()` is the entire interface.
 */
@Injectable()
export class RateLimiterService {
  constructor(private readonly redis: RedisService) {}

  /**
   * @param key unique bucket identifier, e.g. `login:ip:1.2.3.4` or `login:id:alice`
   * @param limit max requests allowed within the window
   * @param windowSeconds window length
   */
  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const redisKey = `ratelimit:${key}`;
    const count = await this.redis.client.incr(redisKey);
    if (count === 1) {
      await this.redis.client.expire(redisKey, windowSeconds);
    }
    const ttl = await this.redis.client.ttl(redisKey);
    const retryAfterSeconds = ttl > 0 ? ttl : windowSeconds;
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      retryAfterSeconds,
    };
  }

  /** Clears a bucket early, e.g. on successful login to forgive prior failed attempts. */
  async reset(key: string): Promise<void> {
    await this.redis.client.del(`ratelimit:${key}`);
  }
}
