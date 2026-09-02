import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ChipsService } from '../src/chips/chips.service';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { TablesService } from '../src/tables/tables.service';

/** Ops surface: /metrics access control + admin table lifecycle. */
describe('Ops (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: import('http').Server;
  let baseUrl: string;

  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const admin = { email: `adm_${suffix}@ex.test`, username: `adm_${suffix}`.slice(0, 20) };
  const player = { email: `pl_${suffix}@ex.test`, username: `pl_${suffix}`.slice(0, 20) };
  const password = 'a-strong-passphrase';
  let adminToken = '';
  let playerToken = '';
  let playerId = '';
  const sockets: Socket[] = [];
  const tableIds: string[] = [];

  beforeAll(async () => {
    process.env.TABLE_START_DELAY_MS = '50';
    process.env.TABLE_NEXT_HAND_DELAY_MS = '50';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['health/live', 'health/ready'] });
    await app.init();
    await app.listen(0);
    prisma = app.get(PrismaService);
    server = app.getHttpServer();
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await request(server)
      .post('/api/auth/register')
      .send({ ...admin, password });
    const pReg = await request(server)
      .post('/api/auth/register')
      .send({ ...player, password });
    playerToken = pReg.body.tokens.accessToken;
    playerId = pReg.body.user.id;

    // promote, then log in so the fresh access token carries role=ADMIN
    await prisma.user.update({ where: { email: admin.email }, data: { role: 'ADMIN' } });
    const login = await request(server)
      .post('/api/auth/login')
      .send({ emailOrUsername: admin.email, password });
    adminToken = login.body.tokens.accessToken;

    tableIds.push(
      (await app.get(TablesService).create({ name: `ops ${suffix}`, smallBlind: 10, bigBlind: 20 }))
        .id,
    );
  }, 30000);

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await prisma.pokerHand
      .deleteMany({ where: { tableId: { in: tableIds } } })
      .catch(() => undefined);
    await prisma.pokerTable.deleteMany({ where: { id: { in: tableIds } } }).catch(() => undefined);
    await prisma.chipLedgerEntry.deleteMany({ where: { userId: playerId } }).catch(() => undefined);
    await prisma.user
      .deleteMany({ where: { email: { in: [admin.email, player.email] } } })
      .catch(() => undefined);
    await app?.close();
  });

  it('gates /api/ops/metrics to admins', async () => {
    expect((await request(server).get('/api/ops/metrics').set(auth(playerToken))).status).toBe(403);

    const res = await request(server).get('/api/ops/metrics').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      uptimeSeconds: expect.any(Number),
      sockets: expect.any(Number),
      tables: {
        activeTables: expect.any(Number),
        seatedPlayers: expect.any(Number),
        stuckTables: 0,
      },
      handsLastMinute: expect.any(Number),
    });
  });

  it('admin CLOSE tears the table down and refunds seated stacks', async () => {
    const tableId = (
      await app.get(TablesService).create({
        name: `ops-close ${suffix}`,
        smallBlind: 10,
        bigBlind: 20,
        maxSeats: 2,
        minBuyIn: 200,
        maxBuyIn: 2000,
      })
    ).id;
    tableIds.push(tableId);

    const s = io(baseUrl, {
      auth: { token: playerToken },
      transports: ['websocket'],
      forceNew: true,
    });
    sockets.push(s);
    await new Promise<void>((r) => s.once('connect', () => r()));
    await new Promise<void>((r) =>
      s.emit('table:join', { tableId, seatNumber: 0, buyIn: 1000 }, () => r()),
    );

    const beforeClose = await app.get(ChipsService).getBalance(playerId);
    expect(beforeClose).toBe(9000); // 10000 - 1000 buy-in

    const res = await request(server)
      .patch(`/api/tables/${tableId}/status`)
      .set(auth(adminToken))
      .send({ status: 'CLOSED' });
    expect(res.status).toBe(200);
    expect(res.body.handNumber).toBeDefined();

    // stack returned, table row CLOSED, runner gone
    expect(await app.get(ChipsService).getBalance(playerId)).toBe(10000);
    const row = await prisma.pokerTable.findUnique({ where: { id: tableId } });
    expect(row?.status).toBe('CLOSED');
    const seats = await prisma.pokerTableSeat.findMany({
      where: { tableId, userId: { not: null } },
    });
    expect(seats).toHaveLength(0);
  }, 20000);

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
});
