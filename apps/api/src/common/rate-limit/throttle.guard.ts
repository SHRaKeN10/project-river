import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppConfigService } from '../../config/app-config.service';
import { RateLimiterService } from './rate-limiter.service';
import { THROTTLE_KEY, ThrottleOptions } from './throttle.decorator';

@Injectable()
export class ThrottleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimiter: RateLimiterService,
    private readonly config: AppConfigService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const options = this.reflector.get<ThrottleOptions | undefined>(THROTTLE_KEY, ctx.getHandler());
    if (!options) return true;

    // The e2e suites share one Redis, so a per-IP register/login budget is a
    // cross-suite coupling (one heavy suite 429s the next) with no upside in
    // tests. Skip the bucket under NODE_ENV=test; the limiter itself is covered
    // by rate-limiter.service.spec.ts.
    if (this.config.get('NODE_ENV') === 'test') return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const result = await this.rateLimiter.consume(
      `${options.key}:ip:${ip}`,
      options.limit,
      options.windowSeconds,
    );
    if (!result.allowed) {
      throw new HttpException(
        { message: 'Too many requests, please try again later.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
