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
import { WaitlistService } from './waitlist.service';

@Controller('lobby')
export class LobbyController {
  constructor(
    private readonly lobby: LobbyService,
    private readonly waitlist: WaitlistService,
  ) {}

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
    return this.waitlist.leave(user.id, id);
  }

  /**
   * The seat currently held for this user at a table (ADR-0031). The client
   * takes it with a normal `table:join` on the returned `seatNumber`, which
   * consumes the hold. 404 if there is no live hold.
   */
  @Post(':id/waitlist/claim')
  @HttpCode(HttpStatus.OK)
  claim(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ seatNumber: number; expiresAt: number }> {
    return this.waitlist.claimInfo(user.id, id);
  }
}
