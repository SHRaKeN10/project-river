import type { RedisService } from '../../infra/redis/redis.service';
import { RateLimiterService } from './rate-limiter.service';

/** Minimal in-memory stand-in for the ioredis calls RateLimiterService makes -
 * exercises the actual counting/expiry logic instead of just asserting calls. */
class FakeRedisClient {
  private store = new Map<string, { count: number; expiresAt: number | null }>();

  async incr(key: string): Promise<number> {
    const entry = this.store.get(key) ?? { count: 0, expiresAt: null };
    entry.count += 1;
    this.store.set(key, entry);
    return entry.count;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  async ttl(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt === null) return -1;
    return Math.max(1, Math.ceil((entry.expiresAt - Date.now()) / 1000));
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
}

function fakeRedisService(): RedisService {
  return { client: new FakeRedisClient() } as unknown as RedisService;
}

describe('RateLimiterService', () => {
  it('allows requests under the limit and decrements remaining', async () => {
    const service = new RateLimiterService(fakeRedisService());
    const a = await service.consume('k', 3, 60);
    const b = await service.consume('k', 3, 60);
    expect(a).toMatchObject({ allowed: true, remaining: 2 });
    expect(b).toMatchObject({ allowed: true, remaining: 1 });
    expect(a.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('blocks once the limit is exceeded', async () => {
    const service = new RateLimiterService(fakeRedisService());
    await service.consume('k', 2, 60);
    await service.consume('k', 2, 60);
    const third = await service.consume('k', 2, 60);
    expect(third).toMatchObject({ allowed: false, remaining: 0 });
  });

  it('keeps buckets independent by key', async () => {
    const service = new RateLimiterService(fakeRedisService());
    await service.consume('a', 1, 60);
    const blockedA = await service.consume('a', 1, 60);
    const allowedB = await service.consume('b', 1, 60);
    expect(blockedA.allowed).toBe(false);
    expect(allowedB.allowed).toBe(true);
  });

  it('reset() clears the bucket so the next consume starts fresh', async () => {
    const service = new RateLimiterService(fakeRedisService());
    await service.consume('k', 1, 60);
    const blocked = await service.consume('k', 1, 60);
    expect(blocked.allowed).toBe(false);

    await service.reset('k');
    const afterReset = await service.consume('k', 1, 60);
    expect(afterReset.allowed).toBe(true);
  });
});
