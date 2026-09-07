import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CreateInviteInput, InviteView } from '@river/shared-types';
import { PrismaService } from '../infra/prisma/prisma.service';
import { InviteInvalidError } from '../observability/error-codes';
import { AuditAction, AuditService } from '../audit/audit.service';

/** Unambiguous alphabet for a hand-typed code (no 0/O/1/I/L). */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(): string {
  const bytes = randomBytes(10);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `river-${out.slice(0, 4)}-${out.slice(4, 10)}`.toLowerCase();
}

/**
 * Closed-alpha invite codes (ADR-0033). Minting + listing are admin-only.
 * Redemption happens inside `AuthService.register`'s transaction so a code can
 * never be over-redeemed under concurrent sign-ups.
 */
@Injectable()
export class InvitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async mint(adminId: string, input: CreateInviteInput): Promise<InviteView> {
    const expiresAt = input.expiresInHours
      ? new Date(Date.now() + input.expiresInHours * 3_600_000)
      : null;

    // Retry once on the astronomically unlikely code collision.
    let row;
    for (let attempt = 0; attempt < 3 && !row; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        row = await this.prisma.inviteCode.create({
          data: {
            code: randomCode(),
            createdById: adminId,
            maxUses: input.maxUses ?? 1,
            expiresAt,
            note: input.note ?? null,
          },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        throw e;
      }
    }
    if (!row) throw new Error('could not mint an invite code');

    await this.audit.log({
      actorUserId: adminId,
      action: AuditAction.INVITE_CREATED,
      targetType: 'InviteCode',
      targetId: row.id,
      metadata: { maxUses: row.maxUses, note: row.note ?? undefined },
    });
    return this.toView(row);
  }

  async list(): Promise<InviteView[]> {
    const rows = await this.prisma.inviteCode.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map((r) => this.toView(r));
  }

  /**
   * Claim one redemption of `code`, atomically. Must run on a transaction
   * client from `register`. Throws {@link InviteInvalidError} if the code is
   * unknown, expired, or out of redemptions.
   */
  async redeem(tx: Prisma.TransactionClient, code: string): Promise<void> {
    const claimed = await tx.$executeRaw`
      UPDATE "InviteCode"
         SET "usedCount" = "usedCount" + 1
       WHERE "code" = ${code}
         AND "usedCount" < "maxUses"
         AND ("expiresAt" IS NULL OR "expiresAt" > now())
    `;
    if (claimed === 0) throw new InviteInvalidError();
  }

  private toView(row: {
    code: string;
    maxUses: number;
    usedCount: number;
    expiresAt: Date | null;
    note: string | null;
    createdAt: Date;
  }): InviteView {
    return {
      code: row.code,
      maxUses: row.maxUses,
      usedCount: row.usedCount,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
