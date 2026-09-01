import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { UserRole } from '@river/shared-types';
import { Roles } from '../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { TablesService, type TableWithSeats } from './tables.service';

const createTableSchema = z.object({
  name: z.string().min(1).max(60),
  smallBlind: z.number().int().positive(),
  bigBlind: z.number().int().positive(),
  maxSeats: z.number().int().min(2).max(9).optional(),
  minBuyIn: z.number().int().positive().optional(),
  maxBuyIn: z.number().int().positive().optional(),
  isPrivate: z.boolean().optional(),
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
  constructor(private readonly tables: TablesService) {}

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
}
