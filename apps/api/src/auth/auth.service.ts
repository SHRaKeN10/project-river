import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Session, User, UserStatus as PrismaUserStatus, VerificationPurpose } from '@prisma/client';
import { PublicUser, UserRole } from '@river/shared-types';
import { PrismaService } from '../infra/prisma/prisma.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { RateLimiterService } from '../common/rate-limit/rate-limiter.service';
import { AppConfigService } from '../config/app-config.service';
import { PasswordService } from './password.service';
import { SessionBlocklistService } from './session-blocklist.service';
import { TokenService } from './token.service';

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

const PASSWORD_RESET_TTL_SECONDS = 30 * 60; // 30 minutes
const EMAIL_VERIFICATION_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const LOGIN_PER_IDENTIFIER_LIMIT = 8;
const LOGIN_PER_IDENTIFIER_WINDOW_SECONDS = 15 * 60;
const PASSWORD_RESET_PER_EMAIL_LIMIT = 3;
const PASSWORD_RESET_PER_EMAIL_WINDOW_SECONDS = 15 * 60;
const EMAIL_VERIFICATION_RESEND_LIMIT = 3;
const EMAIL_VERIFICATION_RESEND_WINDOW_SECONDS = 60 * 60;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly password: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly rateLimiter: RateLimiterService,
    private readonly config: AppConfigService,
    private readonly blocklist: SessionBlocklistService,
  ) {}

  // ---------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------

  async register(
    input: { email: string; username: string; password: string },
    ctx: RequestContext,
  ): Promise<{ user: PublicUser; tokens: IssuedTokens }> {
    const email = input.email.toLowerCase();

    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ email }, { username: input.username }] },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('Email or username already in use');
    }

    const passwordHash = await this.password.hash(input.password);

    const user = await this.prisma.user.create({
      data: { email, username: input.username, passwordHash },
    });

    await this.issueEmailVerificationToken(user);
    await this.audit.log({
      actorUserId: user.id,
      action: AuditAction.USER_REGISTERED,
      targetType: 'User',
      targetId: user.id,
      ip: ctx.ip,
    });

    const { tokens } = await this.startSession(user, ctx);
    return { user: toPublicUser(user), tokens };
  }

  // ---------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------

  async login(
    input: { emailOrUsername: string; password: string },
    ctx: RequestContext,
  ): Promise<{ user: PublicUser; tokens: IssuedTokens }> {
    const identifierKey = input.emailOrUsername.toLowerCase();
    const limit = await this.rateLimiter.consume(
      `login:id:${identifierKey}`,
      LOGIN_PER_IDENTIFIER_LIMIT,
      LOGIN_PER_IDENTIFIER_WINDOW_SECONDS,
    );
    if (!limit.allowed) {
      throw new ForbiddenException('Too many login attempts. Try again later.');
    }

    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: input.emailOrUsername.toLowerCase() }, { username: input.emailOrUsername }],
      },
    });

    if (!user) {
      await this.password.verifyDummy();
      await this.audit.log({
        action: AuditAction.LOGIN_FAILURE,
        metadata: { identifier: input.emailOrUsername, reason: 'no_such_user' },
        ip: ctx.ip,
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordValid = await this.password.verify(user.passwordHash, input.password);
    if (!passwordValid) {
      await this.audit.log({
        actorUserId: user.id,
        action: AuditAction.LOGIN_FAILURE,
        metadata: { reason: 'bad_password' },
        ip: ctx.ip,
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.status !== PrismaUserStatus.ACTIVE) {
      await this.audit.log({
        actorUserId: user.id,
        action: AuditAction.LOGIN_BLOCKED,
        metadata: { status: user.status },
        ip: ctx.ip,
      });
      throw new ForbiddenException('This account is not active');
    }

    await this.rateLimiter.reset(`login:id:${identifierKey}`);
    const { tokens } = await this.startSession(user, ctx);
    await this.audit.log({ actorUserId: user.id, action: AuditAction.LOGIN_SUCCESS, ip: ctx.ip });
    return { user: toPublicUser(user), tokens };
  }

  // ---------------------------------------------------------------------
  // Refresh (rotation + reuse detection)
  // ---------------------------------------------------------------------

  async refresh(rawToken: string, ctx: RequestContext): Promise<IssuedTokens> {
    const tokenHash = this.tokens.hashOpaqueToken(rawToken);
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { session: true, user: true },
    });

    if (!existing) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (existing.revokedAt || existing.session.revokedAt) {
      // A revoked (already-rotated) refresh token was presented again: the
      // token has almost certainly been stolen and replayed. Kill the whole
      // session so both the attacker and the legitimate client are logged out.
      await this.revokeSession(existing.sessionId);
      await this.audit.log({
        actorUserId: existing.userId,
        action: AuditAction.REFRESH_TOKEN_REUSE_DETECTED,
        targetType: 'Session',
        targetId: existing.sessionId,
        ip: ctx.ip,
      });
      throw new UnauthorizedException('Session revoked');
    }

    if (existing.expiresAt.getTime() < Date.now()) {
      await this.prisma.refreshToken.update({
        where: { id: existing.id },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Refresh token expired');
    }

    if (existing.user.status !== PrismaUserStatus.ACTIVE) {
      throw new ForbiddenException('This account is not active');
    }

    const next = this.tokens.generateOpaqueToken();
    const refreshTtlSeconds = this.config.get('JWT_REFRESH_TTL');

    const [, newRow] = await this.prisma.$transaction([
      this.prisma.refreshToken.update({
        where: { id: existing.id },
        data: { revokedAt: new Date() },
      }),
      this.prisma.refreshToken.create({
        data: {
          userId: existing.userId,
          sessionId: existing.sessionId,
          tokenHash: next.hash,
          expiresAt: new Date(Date.now() + refreshTtlSeconds * 1000),
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
      }),
    ]);
    await this.prisma.refreshToken.update({
      where: { id: existing.id },
      data: { replacedById: newRow.id },
    });
    await this.prisma.session.update({
      where: { id: existing.sessionId },
      data: { lastSeenAt: new Date() },
    });

    const access = this.tokens.signAccessToken({
      sub: existing.userId,
      role: existing.user.role as UserRole,
      sid: existing.sessionId,
    });
    return { accessToken: access.token, refreshToken: next.raw, expiresIn: access.expiresIn };
  }

  // ---------------------------------------------------------------------
  // Logout
  // ---------------------------------------------------------------------

  async logout(sessionId: string, actorUserId: string, ctx: RequestContext): Promise<void> {
    await this.revokeSession(sessionId);
    await this.audit.log({
      actorUserId,
      action: AuditAction.LOGOUT,
      targetType: 'Session',
      targetId: sessionId,
      ip: ctx.ip,
    });
  }

  // ---------------------------------------------------------------------
  // Profile
  // ---------------------------------------------------------------------

  async getProfile(userId: string): Promise<PublicUser> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return toPublicUser(user);
  }

  // ---------------------------------------------------------------------
  // Password reset (architecture only - no email sender wired up yet)
  // ---------------------------------------------------------------------

  /**
   * @returns the raw reset token, or `null` if none was issued (no such
   *   account, inactive, or rate-limited). Callers MUST NOT expose the return
   *   value in production - it exists so the pre-email-service dev/test flow
   *   can drive a reset. The HTTP response is identical either way in prod.
   */
  async requestPasswordReset(email: string, ctx: RequestContext): Promise<string | null> {
    const normalized = email.toLowerCase();
    const limit = await this.rateLimiter.consume(
      `pwreset:id:${normalized}`,
      PASSWORD_RESET_PER_EMAIL_LIMIT,
      PASSWORD_RESET_PER_EMAIL_WINDOW_SECONDS,
    );
    // Always behave the same whether or not the account exists, and even
    // when rate-limited - the caller must not be able to distinguish any of
    // these cases (user enumeration).
    if (!limit.allowed) return null;

    const user = await this.prisma.user.findUnique({ where: { email: normalized } });
    if (!user || user.status !== PrismaUserStatus.ACTIVE) return null;

    const token = this.tokens.generateOpaqueToken();
    await this.prisma.verificationToken.create({
      data: {
        userId: user.id,
        purpose: VerificationPurpose.PASSWORD_RESET,
        tokenHash: token.hash,
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_SECONDS * 1000),
      },
    });
    await this.audit.log({
      actorUserId: user.id,
      action: AuditAction.PASSWORD_RESET_REQUESTED,
      ip: ctx.ip,
    });
    this.logDevToken('password reset', user.email, token.raw);
    return token.raw;
  }

  async confirmPasswordReset(
    rawToken: string,
    newPassword: string,
    ctx: RequestContext,
  ): Promise<void> {
    const record = await this.consumeVerificationToken(
      rawToken,
      VerificationPurpose.PASSWORD_RESET,
    );
    const passwordHash = await this.password.hash(newPassword);

    // Changing the password revokes every session everywhere - standard
    // practice in case the password was compromised. Capture the live session
    // ids first so their access tokens can be denylisted too.
    const liveSessions = await this.prisma.session.findMany({
      where: { userId: record.userId, revokedAt: null },
      select: { id: true },
    });

    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
      this.prisma.session.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    await this.blocklist.revokeMany(liveSessions.map((s) => s.id));

    await this.audit.log({
      actorUserId: record.userId,
      action: AuditAction.PASSWORD_RESET_COMPLETED,
      ip: ctx.ip,
    });
  }

  // ---------------------------------------------------------------------
  // Email verification (architecture only - no email sender wired up yet)
  // ---------------------------------------------------------------------

  /** @returns raw token (dev/test only - see requestPasswordReset), or `null`
   *  if the address is already verified. */
  async requestEmailVerification(userId: string): Promise<string | null> {
    const limit = await this.rateLimiter.consume(
      `emailverify:user:${userId}`,
      EMAIL_VERIFICATION_RESEND_LIMIT,
      EMAIL_VERIFICATION_RESEND_WINDOW_SECONDS,
    );
    if (!limit.allowed) {
      throw new ForbiddenException('Too many verification requests. Try again later.');
    }
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.emailVerifiedAt) return null;
    return this.issueEmailVerificationToken(user);
  }

  async confirmEmailVerification(rawToken: string): Promise<void> {
    const record = await this.consumeVerificationToken(
      rawToken,
      VerificationPurpose.EMAIL_VERIFICATION,
    );
    await this.prisma.user.update({
      where: { id: record.userId },
      data: { emailVerifiedAt: new Date() },
    });
    await this.audit.log({ actorUserId: record.userId, action: AuditAction.EMAIL_VERIFIED });
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private async startSession(
    user: User,
    ctx: RequestContext,
  ): Promise<{ session: Session; tokens: IssuedTokens }> {
    const session = await this.prisma.session.create({
      data: { userId: user.id, ip: ctx.ip, userAgent: ctx.userAgent },
    });

    const refresh = this.tokens.generateOpaqueToken();
    const refreshTtlSeconds = this.config.get('JWT_REFRESH_TTL');
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        sessionId: session.id,
        tokenHash: refresh.hash,
        expiresAt: new Date(Date.now() + refreshTtlSeconds * 1000),
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      },
    });

    const access = this.tokens.signAccessToken({
      sub: user.id,
      role: user.role as UserRole,
      sid: session.id,
    });

    return {
      session,
      tokens: { accessToken: access.token, refreshToken: refresh.raw, expiresIn: access.expiresIn },
    };
  }

  private async revokeSession(sessionId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } }),
      this.prisma.refreshToken.updateMany({
        where: { sessionId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    // Kill the access token too, not just refresh - see SessionBlocklistService.
    await this.blocklist.revoke(sessionId);
  }

  private async issueEmailVerificationToken(user: User): Promise<string> {
    const token = this.tokens.generateOpaqueToken();
    await this.prisma.verificationToken.create({
      data: {
        userId: user.id,
        purpose: VerificationPurpose.EMAIL_VERIFICATION,
        tokenHash: token.hash,
        expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_SECONDS * 1000),
      },
    });
    await this.audit.log({
      actorUserId: user.id,
      action: AuditAction.EMAIL_VERIFICATION_REQUESTED,
    });
    this.logDevToken('email verification', user.email, token.raw);
    return token.raw;
  }

  private async consumeVerificationToken(rawToken: string, purpose: VerificationPurpose) {
    const tokenHash = this.tokens.hashOpaqueToken(rawToken);
    const record = await this.prisma.verificationToken.findUnique({ where: { tokenHash } });

    if (
      !record ||
      record.purpose !== purpose ||
      record.consumedAt ||
      record.expiresAt.getTime() < Date.now()
    ) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    await this.prisma.verificationToken.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });
    return record;
  }

  /** TODO(Phase 9): send via a real EmailService instead of logging.
   * Never logged in production - the raw token is a bearer credential. */
  private logDevToken(kind: string, email: string, raw: string): void {
    if (this.config.isProduction) return;
    this.logger.debug(`[dev-only] ${kind} token for ${email}: ${raw}`);
  }
}

function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    avatarUrl: user.avatarUrl,
    status: user.status,
    emailVerified: user.emailVerifiedAt !== null,
    createdAt: user.createdAt.toISOString(),
  };
}
