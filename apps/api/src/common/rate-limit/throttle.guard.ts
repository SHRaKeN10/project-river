import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { RateLimiterService } from './rate-limiter.service';
import { THROTTLE_KEY, ThrottleOptions } from './throttle.decorator';

@Injectable()
export class ThrottleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const options = this.reflector.get<ThrottleOptions | undefined>(THROTTLE_KEY, ctx.getHandler());
    if (!options) return true;

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
