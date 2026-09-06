import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { UserRole } from '@river/shared-types';
import { Roles } from '../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { TableManager } from './table-manager';
import { TablesService, type TableWithSeats } from './tables.service';

const createTableSchema = z.object({
  name: z.string().min(1).max(60),
  gameType: z.enum(['NLHE', 'PLO', 'OMAHA5_HILO']).optional(),
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

/** Only settings that are safe to change on a live table. Blinds / buy-ins /
 * seats / game type are baked into the running engine config and are not here. */
const updateConfigSchema = z
  .object({
    isPrivate: z.boolean().optional(),
    bombPotEnabled: z.boolean().optional(),
    bombPotIntervalHands: z.number().int().min(1).max(1000).optional(),
    bombPotAmount: z.number().int().min(0).optional(),
    straddleEnabled: z.boolean().optional(),
    straddleMultiplier: z.number().int().min(2).max(10).optional(),
    runItTwiceEnabled: z.boolean().optional(),
    antiRatholeMinutes: z.number().int().min(0).max(1440).optional(),
  })
  .refine((o) => Object.values(o).some((v) => v !== undefined), {
    message: 'provide at least one setting to change',
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
    bombPotEnabled: table.bombPotEnabled,
    bombPotIntervalHands: table.bombPotIntervalHands,
    bombPotAmount: table.bombPotAmount,
    straddleEnabled: table.straddleEnabled,
    straddleMultiplier: table.straddleMultiplier,
    runItTwiceEnabled: table.runItTwiceEnabled,
    antiRatholeMinutes: table.antiRatholeMinutes,
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

  /** Admin: change table settings that are safe to apply mid-session - privacy
   * and the bomb-pot cadence (ADR-0026). Persists the change and pushes it into
   * a running table immediately; it takes effect on that table's next hand. */
  @Patch(':id/config')
  @Roles(UserRole.ADMIN)
  async updateConfig(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateConfigSchema)) body: z.infer<typeof updateConfigSchema>,
  ): Promise<ReturnType<typeof toDto>> {
    return toDto(await this.manager.updateTableConfig(id, body));
  }
}
