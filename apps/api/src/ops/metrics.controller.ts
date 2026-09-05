import { Controller, Get } from '@nestjs/common';
import { ChipMovementReason } from '@prisma/client';
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
  /** Table time-charge fees collected (see chips/ChipLedgerEntry), positive
   * chip amounts. Play-money for now, but the same figure a real-money
   * deploy would report as house revenue. */
  timeChargeRevenue: { allTime: number; lastHour: number };
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
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    const [handsLastMinute, allTimeCharges, lastHourCharges] = await Promise.all([
      this.prisma.pokerHand.count({ where: { endedAt: { gte: since } } }),
      this.prisma.chipLedgerEntry.aggregate({
        where: { reason: ChipMovementReason.TABLE_TIME_CHARGE },
        _sum: { amount: true },
      }),
      this.prisma.chipLedgerEntry.aggregate({
        where: { reason: ChipMovementReason.TABLE_TIME_CHARGE, createdAt: { gte: hourAgo } },
        _sum: { amount: true },
      }),
    ]);
    // ledger amounts are signed (negative = left the wallet); charges are
    // always negative, so flip the sign to report a positive revenue figure.
    return {
      uptimeSeconds: Math.round(process.uptime()),
      memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      sockets: this.gateway.connectedSocketCount(),
      tables: this.manager.liveMetrics(),
      handsLastMinute,
      timeChargeRevenue: {
        allTime: -(allTimeCharges._sum.amount ?? 0),
        lastHour: -(lastHourCharges._sum.amount ?? 0),
      },
    };
  }
}
