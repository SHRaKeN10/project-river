import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { TableManager } from '../src/tables/table-manager';
import { TablesService } from '../src/tables/tables.service';

/** Admin `PATCH /tables/:id/config` — persists bomb-pot / privacy settings and
 * pushes them into a running table without a restart. */
describe('Table config (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let manager: TableManager;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let baseUrl: string;

  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const admin = { email: `tcfg_admin_${suffix}@ex.test`, username: `tcfgA_${suffix}`.slice(0, 20) };
  const player = { email: `tcfg_p_${suffix}@ex.test`, username: `tcfgP_${suffix}`.slice(0, 20) };
  const password = 'a-strong-passphrase';
  let adminToken = '';
  let playerToken = '';
  const sockets: Socket[] = [];
  const tableIds: string[] = [];

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
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

    const reg = await request(server)
      .post('/api/auth/register')
      .send({ ...player, password });
    playerToken = reg.body.tokens.accessToken;
  }, 30000);

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await prisma.pokerTable.deleteMany({ where: { id: { in: tableIds } } }).catch(() => undefined);
    await prisma.user
      .deleteMany({ where: { email: { in: [admin.email, player.email] } } })
      .catch(() => undefined);
    await app?.close();
  });

  const makeTable = async (): Promise<string> => {
    const t = await app.get(TablesService).create({
      name: `tcfg ${suffix} ${tableIds.length}`,
      smallBlind: 10,
      bigBlind: 20,
      maxSeats: 3,
      minBuyIn: 200,
      maxBuyIn: 2000,
    });
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
  const settle = () => new Promise((r) => setTimeout(r, 250));

  it('a fresh NLHE table has bomb pots and straddling on at the default cadence', async () => {
    const id = await makeTable();
    const res = await request(server).get(`/api/tables/${id}`).set(auth(playerToken)).expect(200);
    expect(res.body.bombPotEnabled).toBe(true);
    expect(res.body.bombPotIntervalHands).toBe(15);
    expect(res.body.bombPotAmount).toBe(0);
    expect(res.body.straddleEnabled).toBe(true);
    expect(res.body.straddleMultiplier).toBe(2);
    expect(res.body.runItTwiceEnabled).toBe(true);
  });

  it('admin toggles run-it-twice live', async () => {
    const id = await makeTable();
    const watcher = await connect(playerToken);
    await emitAck(watcher, 'table:watch', { tableId: id });
    await settle();
    expect(manager.getRunner(id)!.meta.runItTwiceEnabled).toBe(true);

    await request(server)
      .patch(`/api/tables/${id}/config`)
      .set(auth(adminToken))
      .send({ runItTwiceEnabled: false })
      .expect(200)
      .expect((r) => expect(r.body.runItTwiceEnabled).toBe(false));
    expect(manager.getRunner(id)!.meta.runItTwiceEnabled).toBe(false);
    watcher.disconnect();
  });

  it('admin updates the straddle settings; rejects a multiplier below 2', async () => {
    const id = await makeTable();
    const res = await request(server)
      .patch(`/api/tables/${id}/config`)
      .set(auth(adminToken))
      .send({ straddleEnabled: false, straddleMultiplier: 3 })
      .expect(200);
    expect(res.body).toMatchObject({ straddleEnabled: false, straddleMultiplier: 3 });

    await request(server)
      .patch(`/api/tables/${id}/config`)
      .set(auth(adminToken))
      .send({ straddleMultiplier: 1 })
      .expect(400);
  });

  it('rejects a config change from a non-admin', async () => {
    const id = await makeTable();
    await request(server)
      .patch(`/api/tables/${id}/config`)
      .set(auth(playerToken))
      .send({ bombPotIntervalHands: 10 })
      .expect(403);
  });

  it('admin updates the bomb-pot cadence and it persists', async () => {
    const id = await makeTable();
    const res = await request(server)
      .patch(`/api/tables/${id}/config`)
      .set(auth(adminToken))
      .send({ bombPotEnabled: true, bombPotIntervalHands: 8, bombPotAmount: 40 })
      .expect(200);
    expect(res.body).toMatchObject({
      bombPotEnabled: true,
      bombPotIntervalHands: 8,
      bombPotAmount: 40,
    });

    const row = await prisma.pokerTable.findUnique({ where: { id } });
    expect(row).toMatchObject({ bombPotIntervalHands: 8, bombPotAmount: 40 });
  });

  it('rejects an interval below 1 and an empty patch', async () => {
    const id = await makeTable();
    await request(server)
      .patch(`/api/tables/${id}/config`)
      .set(auth(adminToken))
      .send({ bombPotIntervalHands: 0 })
      .expect(400);
    await request(server)
      .patch(`/api/tables/${id}/config`)
      .set(auth(adminToken))
      .send({})
      .expect(400);
  });

  it('pushes the change into a running table without a restart', async () => {
    const id = await makeTable();
    // spin up a live runner by watching the table
    const watcher = await connect(playerToken);
    await emitAck(watcher, 'table:watch', { tableId: id });
    await settle();
    const runner = manager.getRunner(id)!;
    expect(runner.bombPotView()).toMatchObject({ active: false, nextInHands: 15 });

    await request(server)
      .patch(`/api/tables/${id}/config`)
      .set(auth(adminToken))
      .send({ bombPotIntervalHands: 5, bombPotAmount: 60 })
      .expect(200);

    // same runner instance, new cadence, counter untouched
    expect(manager.getRunner(id)).toBe(runner);
    expect(runner.bombPotView()).toMatchObject({ active: false, amount: 60, nextInHands: 5 });

    // turning it off makes the projection null
    await request(server)
      .patch(`/api/tables/${id}/config`)
      .set(auth(adminToken))
      .send({ bombPotEnabled: false })
      .expect(200);
    expect(runner.bombPotView()).toBeNull();

    watcher.disconnect();
  }, 20000);
});
