import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { TournamentsModule } from '../tournaments/tournaments.module';
import { MetricsController } from './metrics.controller';

/** Operator-facing endpoints (metrics, and later admin table controls). */
@Module({
  imports: [RealtimeModule, TournamentsModule],
  controllers: [MetricsController],
})
export class OpsModule {}
