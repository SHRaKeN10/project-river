import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../infra/prisma/prisma.service';

export interface AuditEntry {
  actorUserId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

/** Canonical security/account event names. Keep this list in sync with what
 * AuthService actually emits - the admin dashboard's activity log (Phase 9)
 * reads AuditLog.action directly. */
export const AuditAction = {
  USER_REGISTERED: 'USER_REGISTERED',
  LOGIN_SUCCESS: 'LOGIN_SUCCESS',
  LOGIN_FAILURE: 'LOGIN_FAILURE',
  LOGIN_BLOCKED: 'LOGIN_BLOCKED',
  LOGOUT: 'LOGOUT',
  REFRESH_TOKEN_REUSE_DETECTED: 'REFRESH_TOKEN_REUSE_DETECTED',
  PASSWORD_RESET_REQUESTED: 'PASSWORD_RESET_REQUESTED',
  PASSWORD_RESET_COMPLETED: 'PASSWORD_RESET_COMPLETED',
  EMAIL_VERIFICATION_REQUESTED: 'EMAIL_VERIFICATION_REQUESTED',
  EMAIL_VERIFIED: 'EMAIL_VERIFIED',
} as const;

/**
 * Append-only audit trail. Never throws into the caller's request path -
 * a logging failure must not break login/register/etc, but it is always
 * loud in the logs so it gets noticed.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorUserId: entry.actorUserId ?? null,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId,
          metadata: entry.metadata as never,
          ip: entry.ip ?? null,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to write audit log for action=${entry.action}: ${(err as Error).message}`,
      );
    }
  }
}
