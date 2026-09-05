import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  createTournamentSchema,
  setTournamentStatusSchema,
  type TournamentView,
  UserRole,
} from '@river/shared-types';
import { CurrentUser, type RequestUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { TournamentsService } from './tournaments.service';

@Controller('tournaments')
export class TournamentsController {
  constructor(private readonly tournaments: TournamentsService) {}

  @Get()
  list(): Promise<TournamentView[]> {
    return this.tournaments.list();
  }

  @Get(':id')
  get(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TournamentView> {
    return this.tournaments.get(id, user.id);
  }

  @Post()
  @Roles(UserRole.ADMIN)
  create(
    @Body(new ZodValidationPipe(createTournamentSchema)) body: unknown,
  ): Promise<TournamentView> {
    return this.tournaments.create(body as Parameters<TournamentsService['create']>[0]);
  }

  @Post(':id/register')
  register(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TournamentView> {
    return this.tournaments.register(user.id, id);
  }

  @Delete(':id/register')
  unregister(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TournamentView> {
    return this.tournaments.unregister(user.id, id);
  }

  @Patch(':id/status')
  @Roles(UserRole.ADMIN)
  setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(setTournamentStatusSchema))
    body: { status: 'REGISTERING' | 'CANCELLED' },
  ): Promise<TournamentView> {
    return this.tournaments.setStatus(id, body.status);
  }
}
