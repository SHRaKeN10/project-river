import { Global, Module } from '@nestjs/common';
import { LobbyController } from './lobby.controller';
import { LobbyGateway } from './lobby.gateway';
import { LobbyService } from './lobby.service';
import { WaitlistService } from './waitlist.service';

@Global()
@Module({
  controllers: [LobbyController],
  providers: [LobbyService, WaitlistService, LobbyGateway],
  exports: [LobbyService, WaitlistService],
})
export class LobbyModule {}
