import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule } from './config/config.module';
import { AppConfigService } from './config/app-config.service';
import { PrismaModule } from './infra/prisma/prisma.module';
import { RedisModule } from './infra/redis/redis.module';
import { HealthModule } from './health/health.module';
import { CommonModule } from './common/common.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { ChipsModule } from './chips/chips.module';
import { TablesModule } from './tables/tables.module';
import { TournamentsModule } from './tournaments/tournaments.module';
import { HandsModule } from './hands/hands.module';
import { LobbyModule } from './lobby/lobby.module';
import { RealtimeModule } from './realtime/realtime.module';
import { OpsModule } from './ops/ops.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.isProduction ? 'info' : 'debug',
          transport: config.isProduction
            ? undefined
            : { target: 'pino-pretty', options: { singleLine: true } },
          redact: ['req.headers.authorization', 'req.headers.cookie'],
          autoLogging: true,
        },
      }),
    }),
    PrismaModule,
    RedisModule,
    CommonModule,
    AuditModule,
    HealthModule,
    AuthModule,
    ChipsModule,
    TablesModule,
    TournamentsModule,
    HandsModule,
    LobbyModule,
    RealtimeModule,
    OpsModule,
  ],
})
export class AppModule {}
