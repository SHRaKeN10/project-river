/**
 * Randomness abstraction for the poker engine.
 *
 * The engine NEVER calls `Math.random()`. Every source of randomness (shuffling
 * in particular) goes through a `RandomProvider` so the implementation can be
 * independently audited, replaced, or made "provably fair" (commit-reveal)
 * later without touching game logic.
 *
 *  - `CryptoRandomProvider` is the production implementation (CSPRNG).
 *  - `SeededRandomProvider` is deterministic and used for tests and for
 *    replaying a stored hand exactly.
 */

import { randomBytes } from 'node:crypto';

export interface RandomProvider {
  /** Uniformly-distributed integer in [0, maxExclusive). Must be unbiased. */
  nextInt(maxExclusive: number): number;
  /** `n` random bytes. */
  bytes(n: number): Uint8Array;
}

function assertValidBound(maxExclusive: number): void {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new RangeError(`maxExclusive must be a positive integer, got ${maxExclusive}`);
  }
}

/**
 * Production CSPRNG. Uses Node's built-in `crypto` - a platform primitive, not a
 * framework dependency. This is the server-side implementation; clients only
 * ever use `SeededRandomProvider` (for replay), so the Node coupling here is
 * intentional and contained behind the `RandomProvider` interface.
 * Rejection sampling removes modulo bias.
 */
export class CryptoRandomProvider implements RandomProvider {
  nextInt(maxExclusive: number): number {
    assertValidBound(maxExclusive);
    if (maxExclusive === 1) return 0;
    // 4 bytes of entropy per draw; reject the tail that would bias the result.
    const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
    for (;;) {
      const value = randomBytes(4).readUInt32BE(0);
      if (value < limit) return value % maxExclusive;
    }
  }

  bytes(n: number): Uint8Array {
    return new Uint8Array(randomBytes(n));
  }
}

/**
 * Deterministic PRNG (mulberry32). NOT cryptographically secure - only for
 * tests, simulations and exact hand replay.
 */
export class SeededRandomProvider implements RandomProvider {
  private state: number;

  constructor(seed: number) {
    if (!Number.isInteger(seed)) {
      throw new TypeError(`seed must be an integer, got ${seed}`);
    }
    this.state = seed >>> 0;
  }

  private nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  nextInt(maxExclusive: number): number {
    assertValidBound(maxExclusive);
    if (maxExclusive === 1) return 0;
    const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
    for (;;) {
      const value = this.nextUint32();
      if (value < limit) return value % maxExclusive;
    }
  }

  bytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) out[i] = this.nextUint32() & 0xff;
    return out;
  }
}
