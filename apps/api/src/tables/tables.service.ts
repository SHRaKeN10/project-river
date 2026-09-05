import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ChipMovementReason,
  PokerTable,
  type PokerGameType,
  PokerTableSeat,
  type PokerTableStatus,
} from '@prisma/client';
import { ChipsService } from '../chips/chips.service';
import { PrismaService } from '../infra/prisma/prisma.service';

export interface CreateTableInput {
  name: string;
  /** Defaults to NLHE. */
  gameType?: PokerGameType;
  smallBlind: number;
  bigBlind: number;
  maxSeats?: number;
  minBuyIn?: number;
  maxBuyIn?: number;
  isPrivate?: boolean;
}

export type TableWithSeats = PokerTable & { seats: PokerTableSeat[] };

export type SitDownResult = { ok: true } | { ok: false; error: string };

@Injectable()
export class TablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chips: ChipsService,
  ) {}

  async create(input: CreateTableInput): Promise<TableWithSeats> {
    if (input.smallBlind <= 0 || input.bigBlind < input.smallBlind) {
      throw new BadRequestException('invalid blinds');
    }
    const maxSeats = input.maxSeats ?? 6;
    if (maxSeats < 2 || maxSeats > 9) throw new BadRequestException('maxSeats must be 2-9');

    const minBuyIn = input.minBuyIn ?? input.bigBlind * 20;
    const maxBuyIn = input.maxBuyIn ?? input.bigBlind * 200;
    if (minBuyIn > maxBuyIn) throw new BadRequestException('minBuyIn cannot exceed maxBuyIn');

    return this.prisma.pokerTable.create({
      data: {
        name: input.name,
        gameType: input.gameType ?? 'NLHE',
        smallBlind: input.smallBlind,
        bigBlind: input.bigBlind,
        maxSeats,
        minBuyIn,
        maxBuyIn,
        isPrivate: input.isPrivate ?? false,
        seats: {
          create: Array.from({ length: maxSeats }, (_, seatNumber) => ({ seatNumber })),
        },
      },
      include: { seats: { orderBy: { seatNumber: 'asc' } } },
    });
  }

  async list(): Promise<TableWithSeats[]> {
    return this.prisma.pokerTable.findMany({
      where: { status: 'ACTIVE', isPrivate: false },
      include: { seats: { orderBy: { seatNumber: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async get(tableId: string): Promise<TableWithSeats> {
    const table = await this.prisma.pokerTable.findUnique({
      where: { id: tableId },
      include: { seats: { orderBy: { seatNumber: 'asc' } } },
    });
    if (!table) throw new NotFoundException('table not found');
    return table;
  }

  /** Admin table lifecycle: ACTIVE <-> PAUSED <-> CLOSED. Runner teardown on
   * CLOSE is the caller's job (it holds the TableManager). */
  async setStatus(tableId: string, status: PokerTableStatus): Promise<TableWithSeats> {
    await this.get(tableId); // 404 if unknown
    return this.prisma.pokerTable.update({
      where: { id: tableId },
      data: { status },
      include: { seats: { orderBy: { seatNumber: 'asc' } } },
    });
  }

  /** Persists the live seat roster + stacks after a hand. */
  async syncSeats(
    tableId: string,
    seats: readonly {
      seatNumber: number;
      userId: string | null;
      stack: number;
      sittingOut: boolean;
    }[],
    handNumber: number,
    previous: {
      buttonSeat: number;
      smallBlindSeat: number | null;
      bigBlindSeat: number;
    } | null,
  ): Promise<void> {
    await this.prisma.$transaction([
      ...seats.map((seat) =>
        this.prisma.pokerTableSeat.update({
          where: { tableId_seatNumber: { tableId, seatNumber: seat.seatNumber } },
          data: {
            userId: seat.userId,
            stack: seat.stack,
            sittingOut: seat.sittingOut,
            joinedAt: seat.userId ? undefined : null,
          },
        }),
      ),
      this.prisma.pokerTable.update({
        where: { id: tableId },
        data: {
          handNumber,
          buttonSeat: previous?.buttonSeat ?? null,
          smallBlindSeat: previous?.smallBlindSeat ?? null,
          bigBlindSeat: previous?.bigBlindSeat ?? null,
        },
      }),
    ]);
  }

  /**
   * Debit the buy-in and claim the seat row in ONE transaction, so a crash can
   * never leave chips debited without a seat (or vice versa). The in-memory
   * `TableRunner` roster is a cache of this row and is rebuilt from it on
   * restart. `idemKey` is unique per join attempt.
   */
  async sitDown(args: {
    tableId: string;
    seatNumber: number;
    userId: string;
    buyIn: number;
    idemKey: string;
  }): Promise<SitDownResult> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const table = await tx.pokerTable.findUnique({
          where: { id: args.tableId },
          select: { status: true },
        });
        if (!table) throw new BadRequestException('table not found');
        if (table.status !== 'ACTIVE') throw new BadRequestException('this table is not open');

        const already = await tx.pokerTableSeat.count({
          where: { tableId: args.tableId, userId: args.userId },
        });
        if (already > 0) throw new BadRequestException('you are already at this table');

        const claimed = await tx.pokerTableSeat.updateMany({
          where: { tableId: args.tableId, seatNumber: args.seatNumber, userId: null },
          data: {
            userId: args.userId,
            stack: args.buyIn,
            sittingOut: false,
            joinedAt: new Date(),
          },
        });
        if (claimed.count === 0) throw new BadRequestException('that seat is taken');

        await this.chips.move(
          {
            userId: args.userId,
            amount: -args.buyIn,
            reason: ChipMovementReason.TABLE_BUYIN,
            idemKey: args.idemKey,
            tableId: args.tableId,
          },
          tx,
        );
      });
      return { ok: true };
    } catch (err) {
      const message =
        err instanceof BadRequestException
          ? ((err.getResponse() as { message?: string }).message ?? 'could not take that seat')
          : 'could not take that seat';
      return { ok: false, error: message };
    }
  }

  /**
   * Release the seat row and return the final stack to the wallet in ONE
   * transaction. Idempotent on `idemKey` - safe to retry after a failure.
   */
  async standUp(args: {
    tableId: string;
    seatNumber: number;
    userId: string;
    finalStack: number;
    idemKey: string;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.pokerTableSeat.updateMany({
        where: { tableId: args.tableId, seatNumber: args.seatNumber, userId: args.userId },
        data: { userId: null, stack: 0, sittingOut: false, joinedAt: null },
      });
      if (args.finalStack > 0) {
        await this.chips.move(
          {
            userId: args.userId,
            amount: args.finalStack,
            reason: ChipMovementReason.TABLE_CASHOUT,
            idemKey: args.idemKey,
            tableId: args.tableId,
          },
          tx,
        );
      }
    });
  }
}
