import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { UserRole } from '@river/shared-types';

/** Set by JwtAuthGuard from the verified access token's claims. */
export interface RequestUser {
  id: string;
  role: UserRole;
  sessionId: string;
}

declare module 'express' {
  interface Request {
    user?: RequestUser;
  }
}

/** Injects the authenticated user (from the verified JWT, not re-fetched from
 * the DB) into a controller method: `@CurrentUser() user: RequestUser`. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<import('express').Request>();
  return req.user;
});
