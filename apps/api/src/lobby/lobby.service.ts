import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { LobbyFilter, LobbyTableDelta, LobbyTableView } from '@river/shared-types';
import { PrismaService } from '../infra/prisma/prisma.service';
import { TableManager } from '../tables/table-manager';

const TABLE_INCLUDE = {
  seats: { select: { userId: true } },
  _count: { select: { waitlist: true } },
} satisfies Prisma.PokerTableInclude;

type TableRow = Prisma.PokerTableGetPayload<{ include: typeof TABLE_INCLUDE }>;

@Injectable()
export class LobbyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tables: TableManager,
  ) {}

  async list(userId: string, filter: LobbyFilter): Promise<LobbyTableView[]> {
    const where: Prisma.PokerTableWhereInput = { status: 'ACTIVE' };
    if (!filter.includePrivate) where.isPrivate = false;
    if (filter.gameType) where.gameType = filter.gameType;
    if (filter.minBigBlind || filter.maxBigBlind) {
      where.bigBlind = {
        ...(filter.minBigBlind ? { gte: filter.minBigBlind } : {}),
        ...(filter.maxBigBlind ? { lte: filter.maxBigBlind } : {}),
      };
    }
    if (filter.favoritesOnly) where.favorites = { some: { userId } };

    const rows = await this.prisma.pokerTable.findMany({
      where,
      include: TABLE_INCLUDE,
      orderBy: [{ bigBlind: 'asc' }, { createdAt: 'asc' }],
    });

    const [favoriteIds, waitlistIds] = await Promise.all([
      this.favoriteTableIds(userId),
      this.waitlistTableIds(userId),
    ]);

    return rows
      .map((row) => this.toView(row, userId, favoriteIds, waitlistIds))
      .filter((view) => !filter.hasOpenSeat || view.openSeats > 0);
  }

  async getOne(userId: string, tableId: string): Promise<LobbyTableView> {
    const row = await this.prisma.pokerTable.findUnique({
      where: { id: tableId },
      include: TABLE_INCLUDE,
    });
    if (!row) throw new NotFoundException('table not found');
    const [favoriteIds, waitlistIds] = await Promise.all([
      this.favoriteTableIds(userId),
      this.waitlistTableIds(userId),
    ]);
    return this.toView(row, userId, favoriteIds, waitlistIds);
  }

  async favorite(userId: string, tableId: string): Promise<void> {
    await this.assertTableExists(tableId);
    await this.prisma.tableFavorite.upsert({
      where: { userId_tableId: { userId, tableId } },
      create: { userId, tableId },
      update: {},
    });
  }

  async unfavorite(userId: string, tableId: string): Promise<void> {
    await this.prisma.tableFavorite.deleteMany({ where: { userId, tableId } });
  }

  async joinWaitlist(userId: string, tableId: string): Promise<{ position: number }> {
    await this.assertTableExists(tableId);
    if (this.isSeated(tableId, userId)) {
      throw new BadRequestException('you are already seated at this table');
    }
    await this.prisma.tableWaitlistEntry.upsert({
      where: { tableId_userId: { tableId, userId } },
      create: { tableId, userId },
      update: {},
    });
    return { position: await this.waitlistPosition(tableId, userId) };
  }

  async leaveWaitlist(userId: string, tableId: string): Promise<void> {
    await this.prisma.tableWaitlistEntry.deleteMany({ where: { tableId, userId } });
  }

  /** Public live snapshot of one table for the `lobby:update` broadcast. */
  async tableDelta(tableId: string): Promise<LobbyTableDelta | null> {
    const row = await this.prisma.pokerTable.findUnique({
      where: { id: tableId },
      select: {
        id: true,
        maxSeats: true,
        status: true,
        handsPlayed: true,
        potSum: true,
        seats: { select: { userId: true } },
        _count: { select: { waitlist: true } },
      },
    });
    if (!row) return null;
    const runner = this.tables.getRunner(tableId);
    const seatedCount = runner ? runner.seatedCount : row.seats.filter((s) => s.userId).length;
    return {
      id: row.id,
      seatedCount,
      openSeats: Math.max(0, row.maxSeats - seatedCount),
      waitlistCount: row._count.waitlist,
      handInProgress: runner?.handInProgress ?? false,
      avgPot: row.handsPlayed > 0 ? Math.round(row.potSum / row.handsPlayed) : 0,
      status: row.status,
    };
  }

  /** The next user waiting for a seat at a table, or null. */
  async waitlistHead(tableId: string): Promise<string | null> {
    const head = await this.prisma.tableWaitlistEntry.findFirst({
      where: { tableId },
      orderBy: { createdAt: 'asc' },
      select: { userId: true },
    });
    return head?.userId ?? null;
  }

  // --- internals --------------------------------------------------------

  private toView(
    row: TableRow,
    userId: string,
    favoriteIds: ReadonlySet<string>,
    waitlistIds: ReadonlySet<string>,
  ): LobbyTableView {
    const runner = this.tables.getRunner(row.id);
    const seatedCount = runner ? runner.seatedCount : row.seats.filter((s) => s.userId).length;
    const openSeats = Math.max(0, row.maxSeats - seatedCount);

    return {
      id: row.id,
      name: row.name,
      gameType: row.gameType,
      smallBlind: row.smallBlind,
      bigBlind: row.bigBlind,
      ante: row.ante,
      maxSeats: row.maxSeats,
      seatedCount,
      openSeats,
      minBuyIn: row.minBuyIn,
      maxBuyIn: row.maxBuyIn,
      status: row.status,
      isPrivate: row.isPrivate,
      handInProgress: runner?.handInProgress ?? false,
      avgPot: row.handsPlayed > 0 ? Math.round(row.potSum / row.handsPlayed) : 0,
      handsPlayed: row.handsPlayed,
      waitlistCount: row._count.waitlist,
      isFavorite: favoriteIds.has(row.id),
      onWaitlist: waitlistIds.has(row.id),
      youAreSeated: runner
        ? runner.seatOf(userId) !== null
        : row.seats.some((s) => s.userId === userId),
    };
  }

  private isSeated(tableId: string, userId: string): boolean {
    return this.tables.getRunner(tableId)?.seatOf(userId) != null;
  }

  private async assertTableExists(tableId: string): Promise<void> {
    const exists = await this.prisma.pokerTable.count({ where: { id: tableId } });
    if (exists === 0) throw new NotFoundException('table not found');
  }

  private async favoriteTableIds(userId: string): Promise<Set<string>> {
    const rows = await this.prisma.tableFavorite.findMany({
      where: { userId },
      select: { tableId: true },
    });
    return new Set(rows.map((r) => r.tableId));
  }

  private async waitlistTableIds(userId: string): Promise<Set<string>> {
    const rows = await this.prisma.tableWaitlistEntry.findMany({
      where: { userId },
      select: { tableId: true },
    });
    return new Set(rows.map((r) => r.tableId));
  }

  private async waitlistPosition(tableId: string, userId: string): Promise<number> {
    const mine = await this.prisma.tableWaitlistEntry.findUnique({
      where: { tableId_userId: { tableId, userId } },
      select: { createdAt: true },
    });
    if (!mine) return 0;
    const ahead = await this.prisma.tableWaitlistEntry.count({
      where: { tableId, createdAt: { lt: mine.createdAt } },
    });
    return ahead + 1;
  }
}
