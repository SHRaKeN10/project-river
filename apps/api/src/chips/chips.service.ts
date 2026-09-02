import { BadRequestException, Injectable } from '@nestjs/common';
import { ChipMovementReason, type Prisma } from '@prisma/client';
import { PrismaService } from '../infra/prisma/prisma.service';

/** Starting / rebuy grant of free-to-play chips. Not money. */
export const CHIP_GRANT = 10_000;

/** A prisma transaction client - `move` composes into a caller's transaction so
 * a balance change and (e.g.) a seat claim commit together or not at all. */
type Tx = Prisma.TransactionClient;

export interface ChipMovement {
  userId: string;
  /** Signed: negative leaves the wallet, positive returns to it. */
  amount: number;
  reason: ChipMovementReason;
  /** Repeat with the same key = no-op (safe to retry after a failure). */
  idemKey: string;
  tableId?: string;
}

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

  /**
   * The single primitive for changing a wallet balance. Atomic with an
   * append-only ledger row. Idempotent on `idemKey`. Pass `tx` to run inside a
   * caller's transaction (so the movement commits with whatever else that
   * transaction is doing).
   *
   * @returns the balance after the movement.
   */
  async move(m: ChipMovement, tx?: Tx): Promise<number> {
    if (!Number.isInteger(m.amount) || m.amount === 0) {
      throw new BadRequestException('chip movement amount must be a non-zero integer');
    }
    const run = (client: Tx): Promise<number> => this.applyMove(client, m);
    return tx ? run(tx) : this.prisma.$transaction((client) => run(client));
  }

  private async applyMove(tx: Tx, m: ChipMovement): Promise<number> {
    const existing = await tx.chipLedgerEntry.findUnique({
      where: { idemKey: m.idemKey },
      select: { balanceAfter: true },
    });
    if (existing) return existing.balanceAfter; // already applied

    if (m.amount < 0) {
      const dec = await tx.user.updateMany({
        where: { id: m.userId, playChips: { gte: -m.amount } },
        data: { playChips: { increment: m.amount } },
      });
      if (dec.count === 0) throw new BadRequestException('insufficient chips');
    } else {
      await tx.user.update({
        where: { id: m.userId },
        data: { playChips: { increment: m.amount } },
      });
    }

    const user = await tx.user.findUniqueOrThrow({
      where: { id: m.userId },
      select: { playChips: true },
    });
    await tx.chipLedgerEntry.create({
      data: {
        userId: m.userId,
        amount: m.amount,
        reason: m.reason,
        balanceAfter: user.playChips,
        tableId: m.tableId ?? null,
        idemKey: m.idemKey,
      },
    });
    return user.playChips;
  }

  /** Dev / free-to-play convenience: top a broke player back up to the grant. */
  async rebuy(userId: string): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { playChips: true },
      });
      if (user.playChips >= CHIP_GRANT) return user.playChips;
      return this.applyMove(tx, {
        userId,
        amount: CHIP_GRANT - user.playChips,
        reason: ChipMovementReason.REBUY_GRANT,
        idemKey: `rebuy:${userId}:${Date.now()}`,
      });
    });
  }
}
