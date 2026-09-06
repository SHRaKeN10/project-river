import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TournamentsModule } from '../tournaments/tournaments.module';
import { PokerGateway } from './poker.gateway';
import { TournamentGateway } from './tournament.gateway';

@Module({
  imports: [AuthModule, TournamentsModule],
  providers: [PokerGateway, TournamentGateway],
  exports: [PokerGateway, TournamentGateway],
})
export class RealtimeModule {}
