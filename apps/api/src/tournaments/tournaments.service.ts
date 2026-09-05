import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ChipMovementReason,
  type PokerGameType,
  type Tournament,
  type TournamentEntry,
} from '@prisma/client';
import {
  type BlindSchedule,
  type GameVariant,
  payoutSchedule,
  placesPaid,
  prizePool as poolFor,
  type TournamentConfig,
  validateTournamentConfig,
} from '@river/poker-engine';
import type {
  BlindLevelWire,
  CreateTournamentInput,
  TournamentEntryView,
  TournamentView,
} from '@river/shared-types';
import { ChipsService } from '../chips/chips.service';
import { PrismaService } from '../infra/prisma/prisma.service';
import { variantForGameType } from '../tables/game-variant';
import { currentLevel, levelEndsAt } from './tournament-clock';

type TournamentRow = Tournament & {
  entries: (TournamentEntry & { user: { username: string } })[];
};

const INCLUDE = { entries: { include: { user: { select: { username: true } } } } } as const;

@Injectable()
export class TournamentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chips: ChipsService,
  ) {}

  async create(input: CreateTournamentInput): Promise<TournamentView> {
    const gameType = (input.gameType ?? 'NLHE') as PokerGameType;
    const config = this.toConfig({
      variant: variantForGameType(gameType),
      buyIn: input.buyIn,
      entryFee: input.entryFee ?? 0,
      startingStack: input.startingStack,
      seatsPerTable: input.seatsPerTable ?? 9,
      blinds: input.blinds,
      lateRegUntilLevel: input.lateRegUntilLevel ?? 1,
      maxEntrants: input.maxEntrants ?? null,
    });
    try {
      validateTournamentConfig(config);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }

    const row = await this.prisma.tournament.create({
      data: {
        name: input.name,
        gameType,
        buyIn: input.buyIn,
        entryFee: input.entryFee ?? 0,
        startingStack: input.startingStack,
        seatsPerTable: input.seatsPerTable ?? 9,
        blindsJson: input.blinds as unknown as object[],
        lateRegUntilLevel: input.lateRegUntilLevel ?? 1,
        maxEntrants: input.maxEntrants ?? null,
      },
      include: INCLUDE,
    });
    return this.toView(row, null);
  }

  async list(): Promise<TournamentView[]> {
    const rows = await this.prisma.tournament.findMany({
      where: { status: { not: 'CANCELLED' } },
      include: INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toView(r, null));
  }

  async get(id: string, userId: string | null): Promise<TournamentView> {
    return this.toView(await this.load(id), userId);
  }

  /** Register a player and take the buy-in + fee from their wallet, atomically. */
  async register(userId: string, id: string): Promise<TournamentView> {
    const row = await this.load(id);
    if (row.status !== 'SCHEDULED' && row.status !== 'REGISTERING') {
      // Late registration once the clock is running lands with the tournament
      // runner; for now registration is pre-start only.
      throw new BadRequestException('registration is not open');
    }
    if (row.maxEntrants !== null && row.entries.length >= row.maxEntrants) {
      throw new BadRequestException('this tournament is full');
    }
    if (row.entries.some((e) => e.userId === userId)) {
      throw new ConflictException('you are already registered');
    }

    const cost = row.buyIn + row.entryFee;
    await this.prisma.$transaction(async (tx) => {
      const entry = await tx.tournamentEntry.create({ data: { tournamentId: id, userId } });
      await this.chips.move(
        {
          userId,
          amount: -cost,
          reason: ChipMovementReason.TOURNAMENT_BUYIN,
          idemKey: `tbuy:${entry.id}`,
        },
        tx,
      );
    });
    return this.get(id, userId);
  }

  /** Cancel a registration before the tournament starts and refund the wallet. */
  async unregister(userId: string, id: string): Promise<TournamentView> {
    const row = await this.load(id);
    if (row.status !== 'SCHEDULED' && row.status !== 'REGISTERING') {
      throw new BadRequestException('the tournament has started - you cannot unregister');
    }
    const entry = row.entries.find((e) => e.userId === userId);
    if (!entry) throw new BadRequestException('you are not registered');

    const refund = row.buyIn + row.entryFee;
    await this.prisma.$transaction(async (tx) => {
      await tx.tournamentEntry.delete({ where: { id: entry.id } });
      await this.chips.move(
        {
          userId,
          amount: refund,
          reason: ChipMovementReason.TOURNAMENT_REFUND,
          idemKey: `tref:${entry.id}`,
        },
        tx,
      );
    });
    return this.get(id, userId);
  }

  /**
   * Admin lifecycle. This PR handles the pre-start transitions:
   *   SCHEDULED -> REGISTERING, and (any) -> CANCELLED (every buy-in refunded).
   * The RUNNING / PAUSED / FINISHED transitions arrive with the tournament
   * runner.
   */
  async setStatus(id: string, status: 'REGISTERING' | 'CANCELLED'): Promise<TournamentView> {
    const row = await this.load(id);

    if (status === 'REGISTERING') {
      if (row.status !== 'SCHEDULED') {
        throw new BadRequestException(`cannot open registration from ${row.status}`);
      }
      await this.prisma.tournament.update({ where: { id }, data: { status: 'REGISTERING' } });
      return this.get(id, null);
    }

    // CANCELLED
    if (row.status === 'FINISHED' || row.status === 'CANCELLED') {
      throw new BadRequestException(`cannot cancel a ${row.status} tournament`);
    }
    await this.prisma.$transaction(async (tx) => {
      for (const e of row.entries) {
        await this.chips.move(
          {
            userId: e.userId,
            amount: row.buyIn + row.entryFee,
            reason: ChipMovementReason.TOURNAMENT_REFUND,
            idemKey: `tcancel:${e.id}`,
          },
          tx,
        );
      }
      await tx.tournament.update({
        where: { id },
        data: { status: 'CANCELLED', finishedAt: new Date() },
      });
    });
    return this.get(id, null);
  }

  // --- internals ----------------------------------------------------------

  private async load(id: string): Promise<TournamentRow> {
    const row = await this.prisma.tournament.findUnique({ where: { id }, include: INCLUDE });
    if (!row) throw new NotFoundException('tournament not found');
    return row;
  }

  private blindsOf(row: Tournament): BlindSchedule {
    return row.blindsJson as unknown as BlindSchedule;
  }

  private toConfig(over: {
    variant: GameVariant;
    buyIn: number;
    entryFee: number;
    startingStack: number;
    seatsPerTable: number;
    blinds: BlindLevelWire[];
    lateRegUntilLevel: number;
    maxEntrants: number | null;
  }): TournamentConfig {
    return { ...over, blinds: over.blinds as unknown as BlindSchedule };
  }

  private configOf(row: Tournament): TournamentConfig {
    return this.toConfig({
      variant: variantForGameType(row.gameType),
      buyIn: row.buyIn,
      entryFee: row.entryFee,
      startingStack: row.startingStack,
      seatsPerTable: row.seatsPerTable,
      blinds: this.blindsOf(row) as unknown as BlindLevelWire[],
      lateRegUntilLevel: row.lateRegUntilLevel,
      maxEntrants: row.maxEntrants,
    });
  }

  private toView(row: TournamentRow, userId: string | null): TournamentView {
    const blinds = this.blindsOf(row) as unknown as BlindLevelWire[];
    const entrants = row.entries.length;
    const clock = {
      startedAt: row.startedAt?.getTime() ?? null,
      pausedMs: row.pausedMs,
      pausedAt: row.pausedAt?.getTime() ?? null,
    };
    const running = row.status === 'RUNNING' || row.status === 'PAUSED';
    const now = Date.now();

    const entryView = (
      e: TournamentEntry & { user: { username: string } },
    ): TournamentEntryView => ({
      userId: e.userId,
      username: e.user.username,
      registeredAt: e.registeredAt.toISOString(),
      stack: e.stack,
      eliminated: e.eliminatedAt !== null,
      finishPosition: e.finishPosition,
      payout: e.payout,
    });

    const mine = userId ? (row.entries.find((e) => e.userId === userId) ?? null) : null;

    const results =
      row.status === 'FINISHED' && Array.isArray(row.resultsJson)
        ? (
            row.resultsJson as unknown as { userId: string; position: number; payout: number }[]
          ).map((r) => ({
            ...r,
            username: row.entries.find((e) => e.userId === r.userId)?.user.username ?? '?',
          }))
        : null;

    return {
      id: row.id,
      name: row.name,
      gameType: row.gameType,
      status: row.status,
      buyIn: row.buyIn,
      entryFee: row.entryFee,
      startingStack: row.startingStack,
      seatsPerTable: row.seatsPerTable,
      blinds,
      lateRegUntilLevel: row.lateRegUntilLevel,
      maxEntrants: row.maxEntrants,

      entrantCount: entrants,
      playersLeft: row.entries.filter((e) => e.eliminatedAt === null).length,
      prizePool: poolFor(this.configOf(row), entrants),
      placesPaid: entrants >= 2 ? placesPaid(entrants) : 0,

      startedAt: clock.startedAt,
      currentLevel: running ? currentLevel(blinds as BlindSchedule, clock, now).level : null,
      levelEndsAt: running ? levelEndsAt(blinds as BlindSchedule, clock, now) : null,

      you: mine ? entryView(mine) : null,
      results,
    };
  }

  /** Exposed for the ops / admin view: what a full field would win. */
  payouts(entrants: number, pool: number): number[] {
    return payoutSchedule(entrants, pool);
  }
}
