import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { lobbyFilterSchema, type LobbyTableView } from '@river/shared-types';
import { CurrentUser, RequestUser } from '../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { LobbyService } from './lobby.service';

@Controller('lobby')
export class LobbyController {
  constructor(private readonly lobby: LobbyService) {}

  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(lobbyFilterSchema)) query: unknown,
  ): Promise<LobbyTableView[]> {
    return this.lobby.list(user.id, query as Record<string, never>);
  }

  @Get(':id')
  getOne(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LobbyTableView> {
    return this.lobby.getOne(user.id, id);
  }

  @Post(':id/favorite')
  @HttpCode(HttpStatus.NO_CONTENT)
  favorite(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.lobby.favorite(user.id, id);
  }

  @Delete(':id/favorite')
  @HttpCode(HttpStatus.NO_CONTENT)
  unfavorite(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.lobby.unfavorite(user.id, id);
  }

  @Post(':id/waitlist')
  @HttpCode(HttpStatus.OK)
  joinWaitlist(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ position: number }> {
    return this.lobby.joinWaitlist(user.id, id);
  }

  @Delete(':id/waitlist')
  @HttpCode(HttpStatus.NO_CONTENT)
  leaveWaitlist(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.lobby.leaveWaitlist(user.id, id);
  }
}
