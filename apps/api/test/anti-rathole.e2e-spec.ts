import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { TableManager } from '../src/tables/table-manager';
import { TablesService } from '../src/tables/tables.service';

/**
 * Anti-ratholing (ADR-0029): a player who voluntarily leaves a cash table
 * cannot return short for `antiRatholeMinutes`. Losing chips elsewhere, a
 * disconnect removal, waiting out the cooldown, or disabling it (0) do not
 * restrict them.
 */
describe('Anti-ratholing (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let manager: TableManager;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let baseUrl: string;

  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const admin = { email: `rh_admin_${suffix}@ex.test`, username: `rhA_${suffix}`.slice(0, 20) };
  const players = [
    { email: `rh1_${suffix}@ex.test`, username: `rh1_${suffix}`.slice(0, 20) },
    { email: `rh2_${suffix}@ex.test`, username: `rh2_${suffix}`.slice(0, 20) },
  ];
  const password = 'a-strong-passphrase';
  let adminToken = '';
  const tokens: string[] = [];
  const userIds: string[] = [];
  const sockets: Socket[] = [];
  const tableIds: string[] = [];

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    process.env.TABLE_START_DELAY_MS = '50';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['health/live', 'health/ready'] });
    await app.init();
    await app.listen(0);
    prisma = app.get(PrismaService);
    manager = app.get(TableManager);
    server = app.getHttpServer();
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await request(server)
      .post('/api/auth/register')
      .send({ ...admin, password });
    await prisma.user.update({ where: { email: admin.email }, data: { role: 'ADMIN' } });
    adminToken = (
      await request(server).post('/api/auth/login').send({ emailOrUsername: admin.email, password })
    ).body.tokens.accessToken;

    for (const p of players) {
      const res = await request(server)
        .post('/api/auth/register')
        .send({ ...p, password });
      tokens.push(res.body.tokens.accessToken);
      userIds.push(res.body.user.id);
      // top up so a big re-buy is affordable
      await prisma.user.update({ where: { id: res.body.user.id }, data: { playChips: 20_000 } });
    }
  }, 30000);

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await prisma.tableDeparture
      .deleteMany({ where: { tableId: { in: tableIds } } })
      .catch(() => undefined);
    await prisma.pokerTable.deleteMany({ where: { id: { in: tableIds } } }).catch(() => undefined);
    await prisma.user
      .deleteMany({ where: { email: { in: [admin.email, ...players.map((p) => p.email)] } } })
      .catch(() => undefined);
    await app?.close();
  });

  const makeTable = async (over: { antiRatholeMinutes?: number } = {}): Promise<string> => {
    const t = await app.get(TablesService).create({
      name: `rh ${suffix} ${tableIds.length}`,
      smallBlind: 10,
      bigBlind: 20,
      maxSeats: 3,
      minBuyIn: 200,
      maxBuyIn: 2000,
    });
    if (over.antiRatholeMinutes !== undefined) {
      await prisma.pokerTable.update({
        where: { id: t.id },
        data: { antiRatholeMinutes: over.antiRatholeMinutes },
      });
    }
    tableIds.push(t.id);
    return t.id;
  };

  const connect = (token: string): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const s = io(baseUrl, { auth: { token }, transports: ['websocket'], forceNew: true });
      s.once('connect', () => resolve(s));
      s.once('connect_error', reject);
      sockets.push(s);
    });
  const emitAck = <T = unknown>(s: Socket, event: string, payload: unknown): Promise<T> =>
    new Promise((resolve) => s.emit(event, payload, (r: T) => resolve(r)));
  const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

  it('blocks an immediate short re-buy at a table you voluntarily left, allows the full one', async () => {
    const t = await makeTable();
    const s = await connect(tokens[0]!);
    expect(
      (await emitAck<any>(s, 'table:join', { tableId: t, seatNumber: 0, buyIn: 1000 })).ok,
    ).toBe(true);
    await settle();
    await emitAck(s, 'table:leave', { tableId: t });
    await manager.settleSeatChanges(t);

    const dep = await prisma.tableDeparture.findUnique({
      where: { tableId_userId: { tableId: t, userId: userIds[0]! } },
    });
    expect(dep?.stack).toBe(1000);

    // short re-buy is refused
    const short = await emitAck<any>(s, 'table:join', { tableId: t, seatNumber: 0, buyIn: 400 });
    expect(short.ok).toBeUndefined();
    expect(short.error).toMatch(/left this table with 1000/i);

    // the full re-buy is allowed, and the departure record is cleared
    expect(
      (await emitAck<any>(s, 'table:join', { tableId: t, seatNumber: 0, buyIn: 1000 })).ok,
    ).toBe(true);
    await manager.settleSeatChanges(t);
    expect(
      await prisma.tableDeparture.findUnique({
        where: { tableId_userId: { tableId: t, userId: userIds[0]! } },
      }),
    ).toBeNull();
    s.emit('table:leave', { tableId: t });
    s.disconnect();
  }, 20000);

  it('allows a short re-buy once the cooldown has passed', async () => {
    const t = await makeTable();
    const s = await connect(tokens[0]!);
    await emitAck(s, 'table:join', { tableId: t, seatNumber: 0, buyIn: 1000 });
    await settle();
    await emitAck(s, 'table:leave', { tableId: t });
    await manager.settleSeatChanges(t);

    // backdate the departure past the 30-minute cooldown
    await prisma.tableDeparture.update({
      where: { tableId_userId: { tableId: t, userId: userIds[0]! } },
      data: { leftAt: new Date(Date.now() - 31 * 60_000) },
    });

    expect(
      (await emitAck<any>(s, 'table:join', { tableId: t, seatNumber: 0, buyIn: 300 })).ok,
    ).toBe(true);
    s.emit('table:leave', { tableId: t });
    s.disconnect();
  }, 20000);

  it('does not record a departure when a seat is vacated non-voluntarily (admin close)', async () => {
    // The seat-vacate reason is carried by the cash-out idemKey prefix:
    // `cashout:` = voluntary leave, `away:` = disconnect sweep, `close:` = admin
    // close. Only `cashout:` (with the feature on) writes an anti-rathole record.
    const t = await makeTable();
    const s = await connect(tokens[1]!);
    await emitAck(s, 'table:join', { tableId: t, seatNumber: 1, buyIn: 1500 });
    await settle();

    await request(server)
      .patch(`/api/tables/${t}/status`)
      .set(auth(adminToken))
      .send({ status: 'CLOSED' })
      .expect(200);
    await manager.settleSeatChanges(t);

    expect(
      await prisma.tableDeparture.findUnique({
        where: { tableId_userId: { tableId: t, userId: userIds[1]! } },
      }),
    ).toBeNull();
    s.disconnect();
  }, 20000);

  it('is skipped entirely when the table sets antiRatholeMinutes to 0', async () => {
    const t = await makeTable({ antiRatholeMinutes: 0 });
    const s = await connect(tokens[0]!);
    await emitAck(s, 'table:join', { tableId: t, seatNumber: 0, buyIn: 2000 });
    await settle();
    await emitAck(s, 'table:leave', { tableId: t });
    await manager.settleSeatChanges(t);
    // no record is even written
    expect(
      await prisma.tableDeparture.findUnique({
        where: { tableId_userId: { tableId: t, userId: userIds[0]! } },
      }),
    ).toBeNull();
    expect(
      (await emitAck<any>(s, 'table:join', { tableId: t, seatNumber: 0, buyIn: 200 })).ok,
    ).toBe(true);
    s.emit('table:leave', { tableId: t });
    s.disconnect();
  }, 20000);

  it('the floor is capped at the table max buy-in', async () => {
    const t = await makeTable();
    // stuff the player's stack above the max via a direct departure record
    const s = await connect(tokens[1]!);
    await emitAck(s, 'table:join', { tableId: t, seatNumber: 2, buyIn: 2000 });
    await settle();
    await emitAck(s, 'table:leave', { tableId: t });
    await manager.settleSeatChanges(t);
    await prisma.tableDeparture.update({
      where: { tableId_userId: { tableId: t, userId: userIds[1]! } },
      data: { stack: 5000 }, // "left with" more than the max buy-in
    });

    // must bring the max (2000), not the full 5000
    const s2 = await connect(tokens[1]!);
    const atMax = await emitAck<any>(s2, 'table:join', { tableId: t, seatNumber: 2, buyIn: 2000 });
    expect(atMax.ok).toBe(true);
    s2.emit('table:leave', { tableId: t });
    s2.disconnect();
    s.disconnect();
  }, 20000);
});
