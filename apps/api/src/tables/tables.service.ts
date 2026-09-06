import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ChipMovementReason,
  PokerTable,
  type PokerGameType,
  PokerTableSeat,
  type PokerTableStatus,
} from '@prisma/client';
import { maxSeatsForVariant } from '@river/poker-engine';
import { ChipsService } from '../chips/chips.service';
import { PrismaService } from '../infra/prisma/prisma.service';
import { variantForGameType } from './game-variant';

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

/** Table settings an admin can change on a table that's already live. Blinds,
 * buy-ins, seat count and game type are deliberately NOT here - those are baked
 * into the running engine config and would need a runner rebuild. */
export interface TableConfigPatch {
  isPrivate?: boolean;
  bombPotEnabled?: boolean;
  bombPotIntervalHands?: number;
  bombPotAmount?: number;
  straddleEnabled?: boolean;
  straddleMultiplier?: number;
  runItTwiceEnabled?: boolean;
  antiRatholeMinutes?: number;
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
    const gameType = input.gameType ?? 'NLHE';
    const maxSeats = input.maxSeats ?? 6;
    if (maxSeats < 2 || maxSeats > 9) throw new BadRequestException('maxSeats must be 2-9');
    const seatCap = maxSeatsForVariant(variantForGameType(gameType));
    if (maxSeats > seatCap) {
      throw new BadRequestException(`${gameType} seats at most ${seatCap} (deck size)`);
    }

    const minBuyIn = input.minBuyIn ?? input.bigBlind * 20;
    const maxBuyIn = input.maxBuyIn ?? input.bigBlind * 200;
    if (minBuyIn > maxBuyIn) throw new BadRequestException('minBuyIn cannot exceed maxBuyIn');

    return this.prisma.pokerTable.create({
      data: {
        name: input.name,
        gameType,
        smallBlind: input.smallBlind,
        bigBlind: input.bigBlind,
        maxSeats,
        minBuyIn,
        maxBuyIn,
        isPrivate: input.isPrivate ?? false,
        // Bomb pots (ADR-0026), straddles (ADR-0027) and Run It Twice (ADR-0028)
        // ship on for NLHE cash only; every other variant plays exactly as before.
        bombPotEnabled: gameType === 'NLHE',
        straddleEnabled: gameType === 'NLHE',
        runItTwiceEnabled: gameType === 'NLHE',
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

  /** Admin: change settings that are safe to apply to a live table (privacy +
   * bomb-pot cadence). Pushing the change into a running `TableRunner` is the
   * caller's job (it holds the `TableManager`); the DB row is the source of
   * truth on the next cold build either way. */
  async updateConfig(tableId: string, patch: TableConfigPatch): Promise<TableWithSeats> {
    await this.get(tableId); // 404 if unknown
    if (patch.bombPotIntervalHands !== undefined && patch.bombPotIntervalHands < 1) {
      throw new BadRequestException('bombPotIntervalHands must be at least 1');
    }
    if (patch.bombPotAmount !== undefined && patch.bombPotAmount < 0) {
      throw new BadRequestException('bombPotAmount cannot be negative');
    }
    if (patch.straddleMultiplier !== undefined && patch.straddleMultiplier < 2) {
      throw new BadRequestException('straddleMultiplier must be at least 2');
    }
    if (patch.antiRatholeMinutes !== undefined && patch.antiRatholeMinutes < 0) {
      throw new BadRequestException('antiRatholeMinutes cannot be negative');
    }
    return this.prisma.pokerTable.update({
      where: { id: tableId },
      data: {
        ...(patch.isPrivate !== undefined && { isPrivate: patch.isPrivate }),
        ...(patch.bombPotEnabled !== undefined && { bombPotEnabled: patch.bombPotEnabled }),
        ...(patch.bombPotIntervalHands !== undefined && {
          bombPotIntervalHands: patch.bombPotIntervalHands,
        }),
        ...(patch.bombPotAmount !== undefined && { bombPotAmount: patch.bombPotAmount }),
        ...(patch.straddleEnabled !== undefined && { straddleEnabled: patch.straddleEnabled }),
        ...(patch.straddleMultiplier !== undefined && {
          straddleMultiplier: patch.straddleMultiplier,
        }),
        ...(patch.runItTwiceEnabled !== undefined && {
          runItTwiceEnabled: patch.runItTwiceEnabled,
        }),
        ...(patch.antiRatholeMinutes !== undefined && {
          antiRatholeMinutes: patch.antiRatholeMinutes,
        }),
      },
      include: { seats: { orderBy: { seatNumber: 'asc' } } },
    });
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
      straddleOn?: boolean;
      runItTwiceOn?: boolean;
    }[],
    handNumber: number,
    previous: {
      buttonSeat: number;
      smallBlindSeat: number | null;
      bigBlindSeat: number;
    } | null,
    handsSinceLastBomb = 0,
  ): Promise<void> {
    await this.prisma.$transaction([
      ...seats.map((seat) =>
        this.prisma.pokerTableSeat.update({
          where: { tableId_seatNumber: { tableId, seatNumber: seat.seatNumber } },
          data: {
            userId: seat.userId,
            stack: seat.stack,
            sittingOut: seat.sittingOut,
            straddleOn: seat.straddleOn ?? false,
            runItTwiceOn: seat.runItTwiceOn ?? false,
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
          handsSinceLastBomb,
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
          select: { status: true, maxBuyIn: true, antiRatholeMinutes: true },
        });
        if (!table) throw new BadRequestException('table not found');
        if (table.status !== 'ACTIVE') throw new BadRequestException('this table is not open');

        const already = await tx.pokerTableSeat.count({
          where: { tableId: args.tableId, userId: args.userId },
        });
        if (already > 0) throw new BadRequestException('you are already at this table');

        // Anti-ratholing (ADR-0029): a player who voluntarily left this table
        // cannot come back short for `antiRatholeMinutes`. Their leaving stack is
        // the floor, capped at the table max. Losing chips elsewhere, a
        // disconnect removal, or waiting out the cooldown do not restrict them.
        if (table.antiRatholeMinutes > 0) {
          const departure = await tx.tableDeparture.findUnique({
            where: { tableId_userId: { tableId: args.tableId, userId: args.userId } },
          });
          if (departure) {
            const cooldownMs = table.antiRatholeMinutes * 60_000;
            const elapsedMs = Date.now() - departure.leftAt.getTime();
            const floor = Math.min(departure.stack, table.maxBuyIn);
            if (elapsedMs < cooldownMs && args.buyIn < floor) {
              const waitMin = Math.ceil((cooldownMs - elapsedMs) / 60_000);
              throw new BadRequestException(
                `you left this table with ${departure.stack} - come back with at least ${floor}, or wait ${waitMin} more minute${waitMin === 1 ? '' : 's'}`,
              );
            }
          }
        }

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

        // They took a seat within the rules - the anti-rathole clock resets.
        await tx.tableDeparture.deleteMany({
          where: { tableId: args.tableId, userId: args.userId },
        });
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
    /** The stack to record for anti-ratholing (ADR-0029). Set only for a
     * VOLUNTARY leave - a disconnect removal or table close passes nothing. */
    recordDepartureStack?: number | null;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.pokerTableSeat.updateMany({
        where: { tableId: args.tableId, seatNumber: args.seatNumber, userId: args.userId },
        data: { userId: null, stack: 0, sittingOut: false, joinedAt: null },
      });
      if (args.recordDepartureStack != null && args.recordDepartureStack > 0) {
        const leftAt = new Date();
        await tx.tableDeparture.upsert({
          where: { tableId_userId: { tableId: args.tableId, userId: args.userId } },
          create: {
            tableId: args.tableId,
            userId: args.userId,
            stack: args.recordDepartureStack,
            leftAt,
          },
          update: { stack: args.recordDepartureStack, leftAt },
        });
      }
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
