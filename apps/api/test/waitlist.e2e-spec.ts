import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { TablesService } from '../src/tables/tables.service';
import { WaitlistService } from '../src/lobby/waitlist.service';

/**
 * Waitlist auto-seat (ADR-0031). The invariant under test: a physical seat can
 * never be claimed by two players, regardless of simultaneous vacate/claim
 * events, reconnects, duplicate messages, or multiple eligible waitlisters.
 * Claiming is idempotent.
 *
 * Each test gets a fresh table so no in-memory `TableRunner` state leaks
 * between cases.
 */
describe('Waitlist auto-seat (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let waitlist: WaitlistService;
  let server: import('http').Server;
  let baseUrl: string;

  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const password = 'a-strong-passphrase';
  const names = ['A', 'B', 'C', 'D', 'E'] as const;
  const emails = names.map((n) => `wl_${n}_${suffix}@ex.test`);
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const createdTables: string[] = [];
  let liveSockets: Socket[] = [];

  const bearer = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  const connect = (who: string): Promise<Socket> =>
    new Promise((resolve) => {
      const s = io(baseUrl, {
        auth: { token: tokens[who] },
        transports: ['websocket'],
        forceNew: true,
      });
      liveSockets.push(s);
      s.once('connect', () => resolve(s));
    });

  const emit = <T = { ok?: true; error?: string }>(
    s: Socket,
    event: string,
    payload: unknown,
  ): Promise<T> =>
    new Promise((resolve) =>
      s.timeout(5000).emit(event, payload, (_e: unknown, ack: T) => resolve(ack ?? ({} as T))),
    );

  const nextOffer = (
    s: Socket,
    timeoutMs = 8000,
  ): Promise<{ seatNumber: number; expiresAt: number } | null> =>
    Promise.race([
      new Promise<{ seatNumber: number; expiresAt: number }>((resolve) =>
        s.once('waitlist:seatAvailable', resolve),
      ),
      sleep(timeoutMs).then(() => null),
    ]);

  const mkTable = async (): Promise<string> => {
    const id = (
      await app.get(TablesService).create({
        name: `wl ${suffix} ${createdTables.length}`,
        smallBlind: 1,
        bigBlind: 2,
        maxSeats: 3,
        minBuyIn: 40,
        maxBuyIn: 400,
      })
    ).id;
    createdTables.push(id);
    return id;
  };

  /** Seat A@0 and B@1 on a fresh table; return their sockets + the table id. */
  const tableWithTwoSeated = async (): Promise<{ tableId: string; sA: Socket; sB: Socket }> => {
    const tableId = await mkTable();
    const [sA, sB] = await Promise.all([connect('A'), connect('B')]);
    await emit(sA, 'table:join', { tableId, seatNumber: 0, buyIn: 100 });
    await emit(sB, 'table:join', { tableId, seatNumber: 1, buyIn: 100 });
    return { tableId, sA, sB };
  };

  const seatedUserIds = async (tableId: string): Promise<string[]> =>
    (
      await prisma.pokerTableSeat.findMany({
        where: { tableId, userId: { not: null } },
        select: { userId: true },
      })
    )
      .map((s) => s.userId as string)
      .sort();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['health/live', 'health/ready'] });
    await app.init();
    await app.listen(0);
    prisma = app.get(PrismaService);
    waitlist = app.get(WaitlistService);
    server = app.getHttpServer();
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    for (let i = 0; i < names.length; i += 1) {
      const res = await request(server)
        .post('/api/auth/register')
        .send({ email: emails[i], username: `wl_${names[i]}_${suffix}`.slice(0, 20), password });
      tokens[names[i]] = res.body.tokens.accessToken;
      ids[names[i]] = res.body.user.id;
    }
  }, 40000);

  afterEach(async () => {
    for (const s of liveSockets) s.disconnect();
    liveSockets = [];
    // Clear this run's waitlist state so the background sweeper doesn't keep
    // churning finished tables and racing the next test.
    await prisma.tableWaitlistEntry
      .deleteMany({ where: { tableId: { in: createdTables } } })
      .catch(() => undefined);
    await prisma.tableSeatReservation
      .deleteMany({ where: { tableId: { in: createdTables } } })
      .catch(() => undefined);
    await sleep(150);
  });

  afterAll(async () => {
    await prisma.tableSeatReservation
      .deleteMany({ where: { tableId: { in: createdTables } } })
      .catch(() => undefined);
    await prisma.chipLedgerEntry
      .deleteMany({ where: { userId: { in: Object.values(ids) } } })
      .catch(() => undefined);
    await prisma.pokerTable
      .deleteMany({ where: { id: { in: createdTables } } })
      .catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { in: emails } } }).catch(() => undefined);
    await app?.close();
  });

  it('promotes the waitlist head onto the freed seat; others are not notified', async () => {
    const { tableId, sA } = await tableWithTwoSeated();
    const [sC, sD] = await Promise.all([connect('C'), connect('D')]);
    await request(server).post(`/api/lobby/${tableId}/waitlist`).set(bearer('C'));
    await request(server).post(`/api/lobby/${tableId}/waitlist`).set(bearer('D'));

    let dNotified = false;
    sD.once('waitlist:seatAvailable', () => {
      dNotified = true;
    });
    const cOfferP = nextOffer(sC);

    await emit(sA, 'table:leave', { tableId });
    const offer = await cOfferP;
    expect(offer).toMatchObject({ seatNumber: 0, expiresAt: expect.any(Number) });

    const ack = await emit(sC, 'table:join', {
      tableId,
      seatNumber: offer!.seatNumber,
      buyIn: 100,
    });
    expect(ack.ok).toBe(true);
    await sleep(200);

    expect(await seatedUserIds(tableId)).toEqual([ids.B, ids.C].sort());
    expect(dNotified).toBe(false);
    expect(await prisma.tableWaitlistEntry.count({ where: { tableId, userId: ids.C } })).toBe(0);
  }, 30000);

  it('a walk-up cannot take the reserved seat, but can take a different open seat', async () => {
    const { tableId, sA } = await tableWithTwoSeated();
    const sC = await connect('C');
    const sE = await connect('E');
    await request(server).post(`/api/lobby/${tableId}/waitlist`).set(bearer('C'));

    const cOfferP = nextOffer(sC);
    await emit(sA, 'table:leave', { tableId });
    const offer = await cOfferP;
    expect(offer).not.toBeNull();

    const blocked = await emit(sE, 'table:join', {
      tableId,
      seatNumber: offer!.seatNumber,
      buyIn: 100,
    });
    expect(blocked.error).toMatch(/reserved/i);

    // seat 2 is the other open seat
    const other = [0, 1, 2].find((n) => n !== offer!.seatNumber && n !== 1)!;
    const ok = await emit(sE, 'table:join', { tableId, seatNumber: other, buyIn: 100 });
    expect(ok.ok).toBe(true);
  }, 30000);

  it('a duplicated claim seats the player exactly once (idempotent, no double debit)', async () => {
    const { tableId, sA } = await tableWithTwoSeated();
    const sC = await connect('C');
    await request(server).post(`/api/lobby/${tableId}/waitlist`).set(bearer('C'));

    const cOfferP = nextOffer(sC);
    await emit(sA, 'table:leave', { tableId });
    const offer = await cOfferP;
    expect(offer).not.toBeNull();

    const before = (await prisma.user.findUnique({
      where: { id: ids.C },
      select: { playChips: true },
    }))!.playChips;

    const [a1, a2] = await Promise.all([
      emit(sC, 'table:join', { tableId, seatNumber: offer!.seatNumber, buyIn: 100 }),
      emit(sC, 'table:join', { tableId, seatNumber: offer!.seatNumber, buyIn: 100 }),
    ]);
    await sleep(200);

    expect([a1, a2].filter((a) => a.ok).length).toBeGreaterThanOrEqual(1);
    expect(await prisma.pokerTableSeat.count({ where: { tableId, userId: ids.C } })).toBe(1);

    const after = (await prisma.user.findUnique({
      where: { id: ids.C },
      select: { playChips: true },
    }))!.playChips;
    expect(before - after).toBe(100);
  }, 30000);

  it('when the head lets the window lapse, they lose their place and the seat passes on', async () => {
    const { tableId, sA } = await tableWithTwoSeated();
    const [sC, sD] = await Promise.all([connect('C'), connect('D')]);
    await request(server).post(`/api/lobby/${tableId}/waitlist`).set(bearer('C'));
    await request(server).post(`/api/lobby/${tableId}/waitlist`).set(bearer('D'));

    const cOfferP = nextOffer(sC);
    const dOfferP = nextOffer(sD);
    await emit(sA, 'table:leave', { tableId });
    expect(await cOfferP).not.toBeNull(); // C is offered first

    // Force C's window to have lapsed, then run the sweep the way the timer does.
    await prisma.tableSeatReservation.updateMany({
      where: { tableId, userId: ids.C },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await waitlist.sweep();

    // C lost their place entirely; D was handed the seat.
    expect(await prisma.tableSeatReservation.count({ where: { tableId, userId: ids.C } })).toBe(0);
    expect(await prisma.tableWaitlistEntry.count({ where: { tableId, userId: ids.C } })).toBe(0);
    const dHolds = await prisma.tableSeatReservation.findMany({
      where: { tableId, userId: ids.D },
    });
    expect(dHolds).toHaveLength(1);
    expect(await dOfferP).toMatchObject({ seatNumber: expect.any(Number) });
  }, 30000);

  it('skips an offline head and reserves for the next online, eligible player', async () => {
    const { tableId, sA } = await tableWithTwoSeated();
    const sC = await connect('C');
    const sD = await connect('D');
    await request(server).post(`/api/lobby/${tableId}/waitlist`).set(bearer('C'));
    await request(server).post(`/api/lobby/${tableId}/waitlist`).set(bearer('D'));

    sC.disconnect();
    await sleep(300);

    const dOfferP = nextOffer(sD);
    await emit(sA, 'table:leave', { tableId });
    expect(await dOfferP).toMatchObject({ seatNumber: expect.any(Number) });

    const holds = await prisma.tableSeatReservation.findMany({ where: { tableId } });
    expect(holds).toHaveLength(1);
    expect(holds[0]!.userId).toBe(ids.D);
  }, 30000);

  it('duplicate vacate events produce exactly one hold; promote with no seat is a no-op', async () => {
    const { tableId, sA } = await tableWithTwoSeated();
    const sE = await connect('E');
    await emit(sE, 'table:join', { tableId, seatNumber: 2, buyIn: 100 }); // table now full
    const sC = await connect('C');
    await request(server).post(`/api/lobby/${tableId}/waitlist`).set(bearer('C'));

    // no free seat -> no-op
    await waitlist.promote(tableId);
    expect(await prisma.tableSeatReservation.count({ where: { tableId } })).toBe(0);

    const cOfferP = nextOffer(sC);
    await emit(sA, 'table:leave', { tableId });
    await cOfferP;

    // hammer it - the @@unique([tableId, seatNumber]) guard means one hold only
    await Promise.all([
      waitlist.promote(tableId),
      waitlist.promote(tableId),
      waitlist.promote(tableId),
    ]);
    await sleep(150);

    const holds = await prisma.tableSeatReservation.findMany({ where: { tableId } });
    expect(holds).toHaveLength(1);
    expect(holds[0]!.userId).toBe(ids.C);
  }, 30000);

  it('a valid hold survives a process restart and stays claimable; an expired one is swept', async () => {
    const tableId = await mkTable();
    await prisma.tableWaitlistEntry.create({ data: { tableId, userId: ids.C } });
    await prisma.tableSeatReservation.create({
      data: { tableId, userId: ids.C, seatNumber: 0, expiresAt: new Date(Date.now() + 60_000) },
    });
    await prisma.tableWaitlistEntry.create({ data: { tableId, userId: ids.D } });
    await prisma.tableSeatReservation.create({
      data: { tableId, userId: ids.D, seatNumber: 1, expiresAt: new Date(Date.now() - 1000) },
    });

    await app.close();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['health/live', 'health/ready'] });
    await app.init();
    await app.listen(0);
    prisma = app.get(PrismaService);
    waitlist = app.get(WaitlistService);
    server = app.getHttpServer();
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await sleep(1200); // boot sweep

    const cClaim = await request(server)
      .post(`/api/lobby/${tableId}/waitlist/claim`)
      .set(bearer('C'));
    expect(cClaim.status).toBe(200);
    expect(cClaim.body).toMatchObject({ seatNumber: 0 });

    expect(await prisma.tableSeatReservation.count({ where: { tableId, userId: ids.D } })).toBe(0);
  }, 40000);
});
