import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PokerGateway } from './poker.gateway';

@Module({
  imports: [AuthModule],
  providers: [PokerGateway],
  exports: [PokerGateway],
})
export class RealtimeModule {}
