import { Module } from '@nestjs/common';
import { TournamentManager } from './tournament-manager';
import { TournamentsController } from './tournaments.controller';
import { TournamentsService } from './tournaments.service';

@Module({
  controllers: [TournamentsController],
  providers: [TournamentsService, TournamentManager],
  exports: [TournamentsService, TournamentManager],
})
export class TournamentsModule {}
