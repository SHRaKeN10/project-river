import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PokerTable, PokerTableSeat } from '@prisma/client';
import { PrismaService } from '../infra/prisma/prisma.service';

export interface CreateTableInput {
  name: string;
  smallBlind: number;
  bigBlind: number;
  maxSeats?: number;
  minBuyIn?: number;
  maxBuyIn?: number;
  isPrivate?: boolean;
}

export type TableWithSeats = PokerTable & { seats: PokerTableSeat[] };

@Injectable()
export class TablesService {
  constructor(private readonly prisma: PrismaService) {}

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

  async claimSeat(
    tableId: string,
    seatNumber: number,
    userId: string,
    stack: number,
  ): Promise<void> {
    const updated = await this.prisma.pokerTableSeat.updateMany({
      where: { tableId, seatNumber, userId: null },
      data: { userId, stack, sittingOut: false, joinedAt: new Date() },
    });
    if (updated.count === 0) throw new BadRequestException('seat is taken');
  }

  async releaseSeat(tableId: string, seatNumber: number): Promise<void> {
    await this.prisma.pokerTableSeat.updateMany({
      where: { tableId, seatNumber },
      data: { userId: null, stack: 0, sittingOut: false, joinedAt: null },
    });
  }
}
