import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { TokenService } from '../../auth/token.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Global guard: every route requires a valid access token unless marked
 * `@Public()`. Registered once (see AuthModule) rather than per-controller so
 * a new route can never be accidentally left unauthenticated.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const token = extractBearerToken(req);
    if (!token) throw new UnauthorizedException('Missing access token');

    const payload = this.tokens.verifyAccessToken(token);
    req.user = { id: payload.sub, role: payload.role, sessionId: payload.sid };
    return true;
  }
}

function extractBearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length).trim() || undefined;
}
