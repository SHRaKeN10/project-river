import { Global, Module } from '@nestjs/common';
import { ChipsController } from './chips.controller';
import { ChipsService } from './chips.service';

@Global()
@Module({
  controllers: [ChipsController],
  providers: [ChipsService],
  exports: [ChipsService],
})
export class ChipsModule {}
