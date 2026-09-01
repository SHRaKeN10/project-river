import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorResult,
  HealthCheckResult,
} from '@nestjs/terminus';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../infra/prisma/prisma.service';
import { RedisService } from '../infra/redis/redis.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Liveness - process is up. Used by orchestrator restart policy. Public:
   * infra probes don't carry an access token. */
  @Public()
  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  /** Readiness - dependencies reachable. Used by the load balancer. Public: see above. */
  @Public()
  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([() => this.checkPrisma(), () => this.checkRedis()]);
  }

  private async checkPrisma(): Promise<HealthIndicatorResult> {
    try {
      await this.prisma.ping();
      return { database: { status: 'up' } };
    } catch (err) {
      return { database: { status: 'down', message: (err as Error).message } };
    }
  }

  private async checkRedis(): Promise<HealthIndicatorResult> {
    try {
      await this.redis.ping();
      return { redis: { status: 'up' } };
    } catch (err) {
      return { redis: { status: 'down', message: (err as Error).message } };
    }
  }
}
