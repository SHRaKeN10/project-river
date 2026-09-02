import { Controller, Get } from '@nestjs/common';
import { UserRole } from '@river/shared-types';
import { Roles } from '../common/decorators/roles.decorator';
import { PrismaService } from '../infra/prisma/prisma.service';
import { PokerGateway } from '../realtime/poker.gateway';
import { TableManager } from '../tables/table-manager';

export interface OpsMetrics {
  uptimeSeconds: number;
  memoryRssMb: number;
  sockets: number;
  tables: {
    activeTables: number;
    seatedPlayers: number;
    handsInProgress: number;
    stuckTables: number;
  };
  handsLastMinute: number;
}

/**
 * Single-node operational snapshot. Admin-only (it exposes table/player
 * counts); a future Prometheus exporter can format the same numbers.
 */
@Controller('ops')
export class MetricsController {
  constructor(
    private readonly manager: TableManager,
    private readonly gateway: PokerGateway,
    private readonly prisma: PrismaService,
  ) {}

  @Get('metrics')
  @Roles(UserRole.ADMIN)
  async metrics(): Promise<OpsMetrics> {
    const since = new Date(Date.now() - 60_000);
    const handsLastMinute = await this.prisma.pokerHand.count({
      where: { endedAt: { gte: since } },
    });
    return {
      uptimeSeconds: Math.round(process.uptime()),
      memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      sockets: this.gateway.connectedSocketCount(),
      tables: this.manager.liveMetrics(),
      handsLastMinute,
    };
  }
}
