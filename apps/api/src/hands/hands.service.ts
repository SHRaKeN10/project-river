import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { PokerHand } from '@prisma/client';
import {
  type EngineAction,
  type GameEvent,
  type GameState,
  createTableConfig,
  parseCard,
  type PreviousPositions,
  replayHand,
} from '@river/poker-engine';
import { UserRole } from '@river/shared-types';
import type { RequestUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../infra/prisma/prisma.service';
import { variantForGameType } from '../tables/game-variant';

interface HandSeat {
  seat: number;
  userId: string;
  username: string;
  startStack: number;
}
interface HandResult {
  seat: number;
  userId: string;
  net: number;
  endStack: number;
}

export interface HandSummaryDto {
  id: string;
  tableId: string;
  handNumber: number;
  board: string[];
  potTotal: number;
  startedAt: string;
  endedAt: string;
  seats: { seat: number; userId: string; username: string }[];
  results: HandResult[];
}

export interface HandDetailDto extends HandSummaryDto {
  engineHandId: string;
  buttonSeat: number;
  smallBlindSeat: number | null;
  bigBlindSeat: number;
  deck: string[];
  actions: EngineAction[];
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

@Injectable()
export class HandsService {
  constructor(private readonly prisma: PrismaService) {}

  private clampLimit(limit?: number): number {
    if (!limit || !Number.isFinite(limit)) return DEFAULT_LIMIT;
    return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
  }

  /** Recent hands at a table. A non-admin only sees hands they were dealt into
   * - other players' results (net / end stack, by name) aren't public, and this
   * also covers private tables. */
  async listForTable(
    tableId: string,
    viewer: RequestUser,
    limit?: number,
  ): Promise<HandSummaryDto[]> {
    const where =
      viewer.role === UserRole.ADMIN ? { tableId } : { tableId, userIds: { has: viewer.id } };
    const hands = await this.prisma.pokerHand.findMany({
      where,
      orderBy: { endedAt: 'desc' },
      take: this.clampLimit(limit),
    });
    return hands.map((h) => toSummary(h));
  }

  async listForUser(userId: string, limit?: number): Promise<HandSummaryDto[]> {
    const hands = await this.prisma.pokerHand.findMany({
      where: { userIds: { has: userId } },
      orderBy: { endedAt: 'desc' },
      take: this.clampLimit(limit),
    });
    return hands.map((h) => toSummary(h));
  }

  async getForViewer(id: string, viewer: RequestUser): Promise<HandDetailDto> {
    const hand = await this.load(id, viewer);
    return toDetail(hand);
  }

  /** Deterministically re-run the persisted hand through the engine. */
  async replayForViewer(
    id: string,
    viewer: RequestUser,
  ): Promise<{ state: GameState; events: GameEvent[] }> {
    const hand = await this.load(id, viewer);
    const table = await this.prisma.pokerTable.findUnique({ where: { id: hand.tableId } });
    if (!table) throw new NotFoundException('table not found');

    const seats = (hand.seatsJson as unknown as HandSeat[]).map((s) => ({
      userId: s.userId,
      seatNumber: s.seat,
      stack: s.startStack,
    }));
    const prev = (hand.prevPositionsJson as unknown as PreviousPositions | null) ?? null;

    return replayHand({
      tableId: hand.tableId,
      config: createTableConfig({
        variant: variantForGameType(table.gameType),
        smallBlind: table.smallBlind,
        bigBlind: table.bigBlind,
        ante: table.ante,
        maxSeats: table.maxSeats,
        minBuyIn: table.minBuyIn,
        maxBuyIn: table.maxBuyIn,
      }),
      seats,
      handId: hand.engineHandId,
      handNumber: hand.handNumber,
      previousPositions: prev,
      deck: (hand.deck as unknown as string[]).map(parseCard),
      actions: hand.actionsJson as unknown as EngineAction[],
      ...(hand.bombPotAmount > 0 ? { bombPot: { amount: hand.bombPotAmount } } : {}),
    });
  }

  private async load(id: string, viewer: RequestUser): Promise<PokerHand> {
    const hand = await this.prisma.pokerHand.findUnique({ where: { id } });
    if (!hand) throw new NotFoundException('hand not found');
    if (viewer.role !== UserRole.ADMIN && !hand.userIds.includes(viewer.id)) {
      throw new ForbiddenException('you did not play this hand');
    }
    return hand;
  }
}

function toSummary(h: PokerHand): HandSummaryDto {
  return {
    id: h.id,
    tableId: h.tableId,
    handNumber: h.handNumber,
    board: h.board,
    potTotal: h.potTotal,
    startedAt: h.startedAt.toISOString(),
    endedAt: h.endedAt.toISOString(),
    seats: (h.seatsJson as unknown as HandSeat[]).map((s) => ({
      seat: s.seat,
      userId: s.userId,
      username: s.username,
    })),
    results: h.resultsJson as unknown as HandResult[],
  };
}

function toDetail(h: PokerHand): HandDetailDto {
  return {
    ...toSummary(h),
    engineHandId: h.engineHandId,
    buttonSeat: h.buttonSeat,
    smallBlindSeat: h.smallBlindSeat,
    bigBlindSeat: h.bigBlindSeat,
    deck: h.deck as unknown as string[],
    actions: h.actionsJson as unknown as EngineAction[],
  };
}
