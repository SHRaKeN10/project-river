import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

@Module({
  // Secret/expiry are passed explicitly per sign()/verify() call from
  // AppConfigService (see TokenService) rather than fixed here, so the same
  // JwtService could sign tokens with different lifetimes if ever needed.
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    // Auth guards are global: every route requires a valid access token
    // unless explicitly marked @Public(). Order matters - JwtAuthGuard must
    // run before RolesGuard so req.user is populated.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [TokenService],
})
export class AuthModule {}
