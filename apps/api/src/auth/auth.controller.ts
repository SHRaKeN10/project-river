import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import {
  AuthResponse,
  emailVerificationConfirmSchema,
  loginSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  PublicUser,
  refreshSchema,
  registerSchema,
} from '@river/shared-types';
import { AppConfigService } from '../config/app-config.service';
import { CurrentUser, RequestUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { Throttle } from '../common/rate-limit/throttle.decorator';
import { ThrottleGuard } from '../common/rate-limit/throttle.guard';
import { AuthService, RequestContext } from './auth.service';

/** Non-production responses surface the freshly-minted verification/reset token
 * so clients can be built and tested before an email service exists (Phase 9).
 * Never returned in production. */
interface DevTokenResponse {
  devToken?: string;
}

@Controller('auth')
@UseGuards(ThrottleGuard)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfigService,
  ) {}

  private devToken(raw: string | null): DevTokenResponse {
    return !this.config.isProduction && raw ? { devToken: raw } : {};
  }

  @Public()
  @Throttle({ key: 'register', limit: 20, windowSeconds: 60 })
  @Post('register')
  async register(
    @Body(new ZodValidationPipe(registerSchema)) body: unknown,
    @Req() req: Request,
  ): Promise<AuthResponse> {
    const input = body as { email: string; username: string; password: string };
    const { user, tokens } = await this.auth.register(input, contextOf(req));
    return { user, tokens };
  }

  @Public()
  @Throttle({ key: 'login', limit: 20, windowSeconds: 60 })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: unknown,
    @Req() req: Request,
  ): Promise<AuthResponse> {
    const input = body as { emailOrUsername: string; password: string };
    const { user, tokens } = await this.auth.login(input, contextOf(req));
    return { user, tokens };
  }

  @Public()
  @Throttle({ key: 'refresh', limit: 30, windowSeconds: 60 })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body(new ZodValidationPipe(refreshSchema)) body: unknown,
    @Req() req: Request,
  ): Promise<{ tokens: AuthResponse['tokens'] }> {
    const { refreshToken } = body as { refreshToken: string };
    const tokens = await this.auth.refresh(refreshToken, contextOf(req));
    return { tokens };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@CurrentUser() user: RequestUser, @Req() req: Request): Promise<void> {
    await this.auth.logout(user.sessionId, user.id, contextOf(req));
  }

  @Get('me')
  async me(@CurrentUser() user: RequestUser): Promise<PublicUser> {
    return this.auth.getProfile(user.id);
  }

  @Public()
  @Throttle({ key: 'password-reset-request', limit: 10, windowSeconds: 60 })
  @Post('password-reset/request')
  @HttpCode(HttpStatus.ACCEPTED)
  async requestPasswordReset(
    @Body(new ZodValidationPipe(passwordResetRequestSchema)) body: unknown,
    @Req() req: Request,
  ): Promise<DevTokenResponse> {
    const { email } = body as { email: string };
    const raw = await this.auth.requestPasswordReset(email, contextOf(req));
    return this.devToken(raw);
  }

  @Public()
  @Throttle({ key: 'password-reset-confirm', limit: 10, windowSeconds: 60 })
  @Post('password-reset/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  async confirmPasswordReset(
    @Body(new ZodValidationPipe(passwordResetConfirmSchema)) body: unknown,
    @Req() req: Request,
  ): Promise<void> {
    const { token, newPassword } = body as { token: string; newPassword: string };
    await this.auth.confirmPasswordReset(token, newPassword, contextOf(req));
  }

  @Post('email-verification/request')
  @HttpCode(HttpStatus.ACCEPTED)
  async requestEmailVerification(@CurrentUser() user: RequestUser): Promise<DevTokenResponse> {
    const raw = await this.auth.requestEmailVerification(user.id);
    return this.devToken(raw);
  }

  @Public()
  @Throttle({ key: 'email-verification-confirm', limit: 10, windowSeconds: 60 })
  @Post('email-verification/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  async confirmEmailVerification(
    @Body(new ZodValidationPipe(emailVerificationConfirmSchema)) body: unknown,
  ): Promise<void> {
    const { token } = body as { token: string };
    await this.auth.confirmEmailVerification(token);
  }
}

function contextOf(req: Request): RequestContext {
  return {
    ip: req.ip ?? req.socket.remoteAddress ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  };
}
