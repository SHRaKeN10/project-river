import { Prisma } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../infra/prisma/prisma.service';
import { InviteInvalidError } from '../observability/error-codes';
import { InvitesService } from './invites.service';

describe('InvitesService', () => {
  const audit = { log: jest.fn() } as unknown as AuditService;

  const makePrisma = (over: Partial<Record<string, unknown>> = {}) =>
    ({
      inviteCode: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'i1',
          usedCount: 0,
          expiresAt: null,
          note: null,
          createdAt: new Date('2026-09-07T00:00:00Z'),
          ...data,
        })),
        findMany: jest.fn(async () => []),
        ...(over.inviteCode as object),
      },
      $executeRaw: jest.fn(async () => 1),
      ...over,
    }) as unknown as PrismaService;

  beforeEach(() => jest.clearAllMocks());

  it('mints a code in the river-xxxx-xxxxxx shape and logs it', async () => {
    const prisma = makePrisma();
    const svc = new InvitesService(prisma, audit);
    const view = await svc.mint('admin-1', { maxUses: 5, note: 'batch' });

    expect(view.code).toMatch(/^river-[a-z2-9]{4}-[a-z2-9]{6}$/);
    expect(view).toMatchObject({ maxUses: 5, usedCount: 0, note: 'batch', expiresAt: null });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 'admin-1', action: 'INVITE_CREATED' }),
    );
  });

  it('computes expiresAt from expiresInHours', async () => {
    const prisma = makePrisma();
    const svc = new InvitesService(prisma, audit);
    const before = Date.now();
    await svc.mint('a', { expiresInHours: 48 });
    const arg = (prisma.inviteCode.create as jest.Mock).mock.calls[0][0].data;
    const delta = (arg.expiresAt as Date).getTime() - before;
    expect(delta).toBeGreaterThan(47.9 * 3_600_000);
    expect(delta).toBeLessThan(48.1 * 3_600_000);
  });

  it('retries once on a code collision (P2002)', async () => {
    const create = jest
      .fn()
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
      )
      .mockResolvedValueOnce({
        id: 'i2',
        code: 'river-aaaa-bbbbbb',
        maxUses: 1,
        usedCount: 0,
        expiresAt: null,
        note: null,
        createdAt: new Date(),
      });
    const prisma = makePrisma({ inviteCode: { create, findMany: jest.fn() } });
    const svc = new InvitesService(prisma, audit);
    const view = await svc.mint('a', {});
    expect(create).toHaveBeenCalledTimes(2);
    expect(view.code).toBe('river-aaaa-bbbbbb');
  });

  it('redeem throws INVITE_INVALID when the guarded UPDATE affects no rows', async () => {
    const prisma = makePrisma({ $executeRaw: jest.fn(async () => 0) });
    const svc = new InvitesService(prisma, audit);
    await expect(svc.redeem(prisma as never, 'river-x')).rejects.toBeInstanceOf(InviteInvalidError);
  });

  it('redeem resolves when the UPDATE claimed a slot', async () => {
    const prisma = makePrisma({ $executeRaw: jest.fn(async () => 1) });
    const svc = new InvitesService(prisma, audit);
    await expect(svc.redeem(prisma as never, 'river-x')).resolves.toBeUndefined();
  });
});
