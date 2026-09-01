import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, type Socket } from 'socket.io-client';
import request, { type Response } from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { TablesService } from '../src/tables/tables.service';

describe('Lobby (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: import('http').Server;
  let baseUrl: string;

  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const tokens: string[] = [];
  const emails = [`lob1_${suffix}@ex.test`, `lob2_${suffix}@ex.test`];
  const password = 'a-strong-passphrase';
  const tableIds: string[] = [];
  const sockets: Socket[] = [];

  const auth = (i: number) => ({ Authorization: `Bearer ${tokens[i]}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['health/live', 'health/ready'] });
    await app.init();
    await app.listen(0);
    prisma = app.get(PrismaService);
    server = app.getHttpServer();
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    for (const email of emails) {
      const res = await request(server)
        .post('/api/auth/register')
        .send({ email, username: email.split('@')[0]!.slice(0, 20), password });
      tokens.push(res.body.tokens.accessToken);
    }

    const tablesSvc = app.get(TablesService);
    tableIds.push(
      (await tablesSvc.create({ name: `micro ${suffix}`, smallBlind: 1, bigBlind: 2, maxSeats: 6 }))
        .id,
      (await tablesSvc.create({ name: `mid ${suffix}`, smallBlind: 25, bigBlind: 50, maxSeats: 6 }))
        .id,
      (
        await tablesSvc.create({
          name: `priv ${suffix}`,
          smallBlind: 5,
          bigBlind: 10,
          isPrivate: true,
        })
      ).id,
    );
  }, 30000);

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await prisma.pokerTable.deleteMany({ where: { id: { in: tableIds } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { in: emails } } }).catch(() => undefined);
    await app?.close();
  });

  const get = (path: string, i = 0): Promise<Response> =>
    request(server).get(`/api/lobby${path}`).set(auth(i));

  it('lists active public tables with the display fields', async () => {
    const res = await get('');
    expect(res.status).toBe(200);
    const names = res.body.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining([`micro ${suffix}`, `mid ${suffix}`]));
    expect(names).not.toContain(`priv ${suffix}`);

    const micro = res.body.find((t: any) => t.name === `micro ${suffix}`);
    expect(micro).toMatchObject({
      bigBlind: 2,
      maxSeats: 6,
      seatedCount: 0,
      openSeats: 6,
      avgPot: 0,
      waitlistCount: 0,
      isFavorite: false,
      onWaitlist: false,
      handInProgress: false,
    });
  });

  it('filters by stake and by privacy', async () => {
    const high = await get('?minBigBlind=40');
    expect(high.body.map((t: any) => t.name)).toEqual([`mid ${suffix}`]);

    const low = await get('?maxBigBlind=5');
    expect(low.body.map((t: any) => t.name)).toEqual([`micro ${suffix}`]);

    const withPrivate = await get('?includePrivate=true');
    expect(withPrivate.body.map((t: any) => t.name)).toEqual(
      expect.arrayContaining([`priv ${suffix}`]),
    );
  });

  it('favourite / unfavourite and the favoritesOnly filter', async () => {
    expect((await get('?favoritesOnly=true')).body).toEqual([]);

    expect(
      (await request(server).post(`/api/lobby/${tableIds[0]}/favorite`).set(auth(0))).status,
    ).toBe(204);
    const favs = await get('?favoritesOnly=true');
    expect(favs.body).toHaveLength(1);
    expect(favs.body[0]).toMatchObject({ id: tableIds[0], isFavorite: true });

    expect(
      (await request(server).delete(`/api/lobby/${tableIds[0]}/favorite`).set(auth(0))).status,
    ).toBe(204);
    expect((await get('?favoritesOnly=true')).body).toEqual([]);
  });

  it('waitlist join reports position and shows on the table', async () => {
    const first = await request(server).post(`/api/lobby/${tableIds[1]}/waitlist`).set(auth(0));
    const second = await request(server).post(`/api/lobby/${tableIds[1]}/waitlist`).set(auth(1));
    expect(first.body).toEqual({ position: 1 });
    expect(second.body).toEqual({ position: 2 });

    const view = await get(`/${tableIds[1]}`, 0);
    expect(view.body).toMatchObject({ waitlistCount: 2, onWaitlist: true });

    expect(
      (await request(server).delete(`/api/lobby/${tableIds[1]}/waitlist`).set(auth(0))).status,
    ).toBe(204);
    expect((await get(`/${tableIds[1]}`, 0)).body.waitlistCount).toBe(1);
  });

  it('pushes a lobby:update when a table gets busy', async () => {
    const updates: any[] = [];
    const lobbySocket = io(baseUrl, {
      auth: { token: tokens[0] },
      transports: ['websocket'],
      forceNew: true,
    });
    sockets.push(lobbySocket);
    await new Promise<void>((res) => lobbySocket.once('connect', () => res()));
    lobbySocket.on('lobby:update', (d) => updates.push(d));
    await new Promise<void>((res) => lobbySocket.emit('lobby:subscribe', {}, () => res()));

    // two players sit down and start a hand at table 0
    const a = io(baseUrl, {
      auth: { token: tokens[0] },
      transports: ['websocket'],
      forceNew: true,
    });
    const b = io(baseUrl, {
      auth: { token: tokens[1] },
      transports: ['websocket'],
      forceNew: true,
    });
    sockets.push(a, b);
    await Promise.all([
      new Promise<void>((r) => a.once('connect', () => r())),
      new Promise<void>((r) => b.once('connect', () => r())),
    ]);
    await new Promise<void>((r) =>
      a.emit('table:join', { tableId: tableIds[0], seatNumber: 0, buyIn: 200 }, () => r()),
    );
    await new Promise<void>((r) =>
      b.emit('table:join', { tableId: tableIds[0], seatNumber: 1, buyIn: 200 }, () => r()),
    );

    await new Promise((res) => setTimeout(res, 800));
    const forOurTable = updates.filter((u) => u.id === tableIds[0]);
    expect(forOurTable.length).toBeGreaterThan(0);
    expect(forOurTable.some((u) => u.seatedCount === 2)).toBe(true);
  }, 20000);
});
