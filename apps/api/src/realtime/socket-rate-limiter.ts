/**
 * Per-socket, in-memory token-bucket rate limiter for gateway messages.
 *
 * A socket only ever lives on one API node, so there's nothing to coordinate
 * across nodes - an in-memory bucket is both correct and cheaper than a Redis
 * round-trip on every message. Buckets are dropped when the socket disconnects.
 */

export type RateClass = 'action' | 'chat' | 'room' | 'misc';

interface Bucket {
  tokens: number;
  last: number;
}

interface ClassConfig {
  /** Bucket capacity (max burst). */
  capacity: number;
  /** Tokens refilled per second (sustained rate). */
  refillPerSec: number;
}

const CLASS_CONFIG: Record<RateClass, ClassConfig> = {
  // A hand rarely needs more than a few actions from one player; this still
  // leaves generous headroom for fast, legitimate clicking.
  action: { capacity: 15, refillPerSec: 3 },
  chat: { capacity: 5, refillPerSec: 0.5 },
  // join / leave / watch / unwatch - guards against reconnect storms.
  room: { capacity: 10, refillPerSec: 1 },
  misc: { capacity: 20, refillPerSec: 5 },
};

export class SocketRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /**
   * Consume one token for `socketId` in the given class. Returns true if the
   * message is allowed, false if the client is over its limit.
   */
  allow(socketId: string, klass: RateClass): boolean {
    const cfg = CLASS_CONFIG[klass];
    const key = `${socketId}:${klass}`;
    const t = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: cfg.capacity, last: t };

    const elapsedSec = Math.max(0, (t - bucket.last) / 1000);
    bucket.tokens = Math.min(cfg.capacity, bucket.tokens + elapsedSec * cfg.refillPerSec);
    bucket.last = t;

    let allowed = false;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      allowed = true;
    }
    this.buckets.set(key, bucket);
    return allowed;
  }

  /** Forget every bucket for a socket (call on disconnect). */
  forget(socketId: string): void {
    for (const klass of Object.keys(CLASS_CONFIG) as RateClass[]) {
      this.buckets.delete(`${socketId}:${klass}`);
    }
  }

  /** Test / diagnostics. */
  get size(): number {
    return this.buckets.size;
  }
}
