import { Module } from '@nestjs/common';
import { HandsController } from './hands.controller';
import { HandsService } from './hands.service';

@Module({
  controllers: [HandsController],
  providers: [HandsService],
  exports: [HandsService],
})
export class HandsModule {}
