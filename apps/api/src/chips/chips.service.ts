import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma/prisma.service';

/** Starting / rebuy grant of free-to-play chips. Not money. */
export const CHIP_GRANT = 10_000;

@Injectable()
export class ChipsService {
  constructor(private readonly prisma: PrismaService) {}

  async getBalance(userId: string): Promise<number> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { playChips: true },
    });
    return user.playChips;
  }

  /** Moves `amount` from a player's balance onto a table. Throws if short. */
  async debit(userId: string, amount: number): Promise<void> {
    if (amount <= 0) throw new BadRequestException('amount must be positive');
    const updated = await this.prisma.user.updateMany({
      where: { id: userId, playChips: { gte: amount } },
      data: { playChips: { decrement: amount } },
    });
    if (updated.count === 0) throw new BadRequestException('insufficient chips');
  }

  /** Returns chips to a player's balance (leaving a table / cashing out). */
  async credit(userId: string, amount: number): Promise<void> {
    if (amount <= 0) return;
    await this.prisma.user.update({
      where: { id: userId },
      data: { playChips: { increment: amount } },
    });
  }

  /** Dev/free-to-play convenience: top a broke player back up to the grant. */
  async rebuy(userId: string): Promise<number> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { playChips: true },
    });
    if (user.playChips >= CHIP_GRANT) return user.playChips;
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { playChips: CHIP_GRANT },
      select: { playChips: true },
    });
    return updated.playChips;
  }
}
