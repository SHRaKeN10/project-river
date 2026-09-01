import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { UserRole } from '@river/shared-types';
import { ROLES_KEY } from '../decorators/roles.decorator';

/** Runs after JwtAuthGuard. No `@Roles()` on the route = any authenticated user. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.user || !required.includes(req.user.role)) {
      throw new ForbiddenException('Insufficient role');
    }
    return true;
  }
}
