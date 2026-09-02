import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type RequestUser } from '../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { HandsService, type HandDetailDto, type HandSummaryDto } from './hands.service';

const tableQuerySchema = z.object({
  tableId: z.string().uuid(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const mineQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
});

@Controller('hands')
export class HandsController {
  constructor(private readonly hands: HandsService) {}

  /** The caller's recent hands at one table (an admin sees every hand there). */
  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(tableQuerySchema))
    query: z.infer<typeof tableQuerySchema>,
  ): Promise<HandSummaryDto[]> {
    return this.hands.listForTable(query.tableId, user, query.limit);
  }

  /** The caller's own recent hands across all tables. */
  @Get('mine')
  mine(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(mineQuerySchema))
    query: z.infer<typeof mineQuerySchema>,
  ): Promise<HandSummaryDto[]> {
    return this.hands.listForUser(user.id, query.limit);
  }

  /** Full detail (deck + action list). Participants and admins only. */
  @Get(':id')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<HandDetailDto> {
    return this.hands.getForViewer(id, user);
  }

  /** Deterministic engine replay of the hand. Participants and admins only. */
  @Get(':id/replay')
  replay(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<unknown> {
    return this.hands.replayForViewer(id, user);
  }
}
