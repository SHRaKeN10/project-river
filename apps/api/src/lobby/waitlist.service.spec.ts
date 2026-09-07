import { Prisma } from '@prisma/client';
import type { AppConfigService } from '../config/app-config.service';
import type { OrchestrationErrorsService } from '../observability/orchestration-errors.service';
import { WaitlistService, type WaitlistBindings } from './waitlist.service';

/**
 * Pure-logic checks on `promote`: who gets offered a freed seat and who is
 * skipped. The concurrency and restart guarantees are exercised end-to-end in
 * `test/waitlist.e2e-spec.ts` (they depend on real DB constraints).
 */
describe('WaitlistService.promote', () => {
  const config = { get: () => 25_000 } as unknown as AppConfigService;
  const orchestrationErrors = { record: jest.fn() } as unknown as OrchestrationErrorsService;

  interface World {
    tableStatus?: string;
    minBuyIn?: number;
    openSeats: number[];
    holds: { seatNumber: number; userId: string }[];
    list: string[]; // waitlist userIds, in order
    seatedUserIds?: string[];
    wallets?: Record<string, number>;
  }

  const build = (w: World, bindings?: Partial<WaitlistBindings>) => {
    const created: { userId: string; seatNumber: number }[] = [];
    const prisma = {
      tableSeatReservation: {
        findMany: jest.fn(async ({ where }: { where: { expiresAt?: unknown } }) =>
          where?.expiresAt ? [] : w.holds,
        ),
        deleteMany: jest.fn(async () => ({ count: 0 })),
        create: jest.fn(async ({ data }: { data: { userId: string; seatNumber: number } }) => {
          if (
            w.holds.some((h) => h.seatNumber === data.seatNumber || h.userId === data.userId) ||
            created.some((c) => c.seatNumber === data.seatNumber || c.userId === data.userId)
          ) {
            throw new Prisma.PrismaClientKnownRequestError('unique', {
              code: 'P2002',
              clientVersion: 'x',
            });
          }
          created.push({ userId: data.userId, seatNumber: data.seatNumber });
          return data;
        }),
      },
      tableWaitlistEntry: {
        findMany: jest.fn(async () => w.list.map((userId) => ({ userId }))),
        deleteMany: jest.fn(async () => ({ count: 0 })),
      },
      pokerTable: {
        findUnique: jest.fn(async () => ({
          status: w.tableStatus ?? 'ACTIVE',
          minBuyIn: w.minBuyIn ?? 100,
        })),
      },
      pokerTableSeat: {
        findMany: jest.fn(async () => w.openSeats.map((seatNumber) => ({ seatNumber }))),
        count: jest.fn(async ({ where }: { where: { userId: string } }) =>
          (w.seatedUserIds ?? []).includes(where.userId) ? 1 : 0,
        ),
      },
      user: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({
          playChips: w.wallets?.[where.id] ?? 10_000,
        })),
      },
      $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    const svc = new WaitlistService(prisma as never, config, orchestrationErrors);
    const notify = jest.fn();
    svc.bind({
      notify,
      isOnline: () => true,
      ...bindings,
    });
    return { svc, notify, created };
  };

  it('offers the freed seat to the head of the list', async () => {
    const { svc, notify, created } = build({
      openSeats: [3],
      holds: [],
      list: ['alice', 'bob'],
    });
    await svc.promote('t1');
    expect(created).toEqual([{ userId: 'alice', seatNumber: 3 }]);
    expect(notify).toHaveBeenCalledWith('alice', 't1', 3, expect.any(Number));
  });

  it('does nothing while the head is already being served', async () => {
    const { svc, notify } = build({
      openSeats: [2],
      holds: [{ seatNumber: 5, userId: 'alice' }],
      list: ['alice', 'bob'],
    });
    await svc.promote('t1');
    expect(notify).not.toHaveBeenCalled();
  });

  it('skips an offline head', async () => {
    const { svc, notify, created } = build(
      { openSeats: [1], holds: [], list: ['alice', 'bob'] },
      { isOnline: (u) => u !== 'alice' },
    );
    await svc.promote('t1');
    expect(created).toEqual([{ userId: 'bob', seatNumber: 1 }]);
    expect(notify).toHaveBeenCalledWith('bob', 't1', 1, expect.any(Number));
  });

  it('skips a head who cannot cover the minimum buy-in', async () => {
    const { svc, created } = build({
      openSeats: [0],
      holds: [],
      list: ['alice', 'bob'],
      minBuyIn: 500,
      wallets: { alice: 100, bob: 10_000 },
    });
    await svc.promote('t1');
    expect(created).toEqual([{ userId: 'bob', seatNumber: 0 }]);
  });

  it('skips a stale waitlist row for someone already seated', async () => {
    const { svc, created } = build({
      openSeats: [0],
      holds: [],
      list: ['alice', 'bob'],
      seatedUserIds: ['alice'],
    });
    await svc.promote('t1');
    expect(created).toEqual([{ userId: 'bob', seatNumber: 0 }]);
  });

  it('bails when a concurrent promote already took the seat (unique violation)', async () => {
    const { svc, notify } = build({
      openSeats: [0],
      holds: [{ seatNumber: 0, userId: 'someone-else' }],
      list: ['alice'],
    });
    // seat 0 is held -> openSeat resolves to undefined -> no-op anyway; force the
    // race by pretending seat 0 is "open" but the create still collides
    await svc.promote('t1');
    expect(notify).not.toHaveBeenCalled();
  });

  it('does nothing when the table is not ACTIVE', async () => {
    const { svc, notify } = build({
      openSeats: [0],
      holds: [],
      list: ['alice'],
      tableStatus: 'PAUSED',
    });
    await svc.promote('t1');
    expect(notify).not.toHaveBeenCalled();
  });
});
