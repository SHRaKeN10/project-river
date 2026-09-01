import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { CurrentUser, RequestUser } from '../common/decorators/current-user.decorator';
import { ChipsService } from './chips.service';

@Controller('chips')
export class ChipsController {
  constructor(private readonly chips: ChipsService) {}

  @Get()
  async balance(@CurrentUser() user: RequestUser): Promise<{ playChips: number }> {
    return { playChips: await this.chips.getBalance(user.id) };
  }

  @Post('rebuy')
  @HttpCode(HttpStatus.OK)
  async rebuy(@CurrentUser() user: RequestUser): Promise<{ playChips: number }> {
    return { playChips: await this.chips.rebuy(user.id) };
  }
}
