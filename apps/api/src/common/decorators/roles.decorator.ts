import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@river/shared-types';

export const ROLES_KEY = 'roles';

/** Restricts a route to the given roles. No decorator = any authenticated user. */
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
