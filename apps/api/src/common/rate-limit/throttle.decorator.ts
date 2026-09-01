import { SetMetadata } from '@nestjs/common';

export const THROTTLE_KEY = 'throttle';

export interface ThrottleOptions {
  /** Bucket name, e.g. 'register', 'login-ip'. Combined with the caller's IP. */
  key: string;
  limit: number;
  windowSeconds: number;
}

/** Applies per-IP rate limiting to a route via ThrottleGuard. */
export const Throttle = (options: ThrottleOptions): MethodDecorator =>
  SetMetadata(THROTTLE_KEY, options);
