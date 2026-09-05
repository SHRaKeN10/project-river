import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { UserRole } from '@river/shared-types';
import { Roles } from '../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { TableManager } from './table-manager';
import { TablesService, type TableWithSeats } from './tables.service';

const createTableSchema = z.object({
  name: z.string().min(1).max(60),
  gameType: z.enum(['NLHE', 'PLO']).optional(),
  smallBlind: z.number().int().positive(),
  bigBlind: z.number().int().positive(),
  maxSeats: z.number().int().min(2).max(9).optional(),
  minBuyIn: z.number().int().positive().optional(),
  maxBuyIn: z.number().int().positive().optional(),
  isPrivate: z.boolean().optional(),
});

const setStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'PAUSED', 'CLOSED']),
});

function toDto(table: TableWithSeats) {
  return {
    id: table.id,
    name: table.name,
    gameType: table.gameType,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    ante: table.ante,
    maxSeats: table.maxSeats,
    minBuyIn: table.minBuyIn,
    maxBuyIn: table.maxBuyIn,
    isPrivate: table.isPrivate,
    handNumber: table.handNumber,
    seats: table.seats.map((s) => ({
      seatNumber: s.seatNumber,
      occupied: s.userId !== null,
      sittingOut: s.sittingOut,
    })),
    seatedCount: table.seats.filter((s) => s.userId !== null).length,
  };
}

@Controller('tables')
export class TablesController {
  constructor(
    private readonly tables: TablesService,
    private readonly manager: TableManager,
  ) {}

  @Get()
  async list(): Promise<ReturnType<typeof toDto>[]> {
    return (await this.tables.list()).map(toDto);
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<ReturnType<typeof toDto>> {
    return toDto(await this.tables.get(id));
  }

  @Post()
  @Roles(UserRole.ADMIN)
  async create(
    @Body(new ZodValidationPipe(createTableSchema)) body: unknown,
  ): Promise<ReturnType<typeof toDto>> {
    return toDto(await this.tables.create(body as z.infer<typeof createTableSchema>));
  }

  /** Admin: pause / resume / close a table. Closing also tears the live runner
   * down and returns every seated stack to its owner's wallet. */
  @Patch(':id/status')
  @Roles(UserRole.ADMIN)
  async setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(setStatusSchema)) body: z.infer<typeof setStatusSchema>,
  ): Promise<ReturnType<typeof toDto>> {
    if (body.status === 'CLOSED') await this.manager.closeTable(id);
    return toDto(await this.tables.setStatus(id, body.status));
  }
}
