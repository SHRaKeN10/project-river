import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { standardBlindSchedule } from '@river/poker-engine';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infra/prisma/prisma.service';

/** Tournament registration and pre-start lifecycle. */
describe('Tournaments (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;

  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const admin = { email: `tadm_${suffix}@ex.test`, username: `tadm_${suffix}`.slice(0, 20) };
  const players = [0, 1, 2].map((i) => ({
    email: `tp${i}_${suffix}@ex.test`,
    username: `tp${i}_${suffix}`.slice(0, 20),
  }));
  const password = 'a-strong-passphrase';
  let adminToken = '';
  const tokens: string[] = [];
  const userIds: string[] = [];
  const tournamentIds: string[] = [];

  const blinds = standardBlindSchedule({
    startingBigBlind: 20,
    levelDurationMs: 600_000,
    levels: 8,
  });

  const balance = async (i: number): Promise<number> => {
    const u = await prisma.user.findUniqueOrThrow({
      where: { id: userIds[i] },
      select: { playChips: true },
    });
    return u.playChips;
  };

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['health/live', 'health/ready'] });
    await app.init();
    await app.listen(0);
    prisma = app.get(PrismaService);
    server = app.getHttpServer();

    await request(server)
      .post('/api/auth/register')
      .send({ ...admin, password });
    await prisma.user.update({ where: { email: admin.email }, data: { role: 'ADMIN' } });
    adminToken = (
      await request(server).post('/api/auth/login').send({ emailOrUsername: admin.email, password })
    ).body.tokens.accessToken;

    for (const p of players) {
      const reg = await request(server)
        .post('/api/auth/register')
        .send({ ...p, password });
      tokens.push(reg.body.tokens.accessToken);
      userIds.push(reg.body.user.id);
    }
  }, 30000);

  afterAll(async () => {
    await prisma.tournament
      .deleteMany({ where: { id: { in: tournamentIds } } })
      .catch(() => undefined);
    await prisma.chipLedgerEntry
      .deleteMany({ where: { userId: { in: userIds } } })
      .catch(() => undefined);
    await prisma.user
      .deleteMany({ where: { email: { in: [admin.email, ...players.map((p) => p.email)] } } })
      .catch(() => undefined);
    await app?.close();
  });

  const create = async (over: Record<string, unknown> = {}): Promise<string> => {
    const res = await request(server)
      .post('/api/tournaments')
      .set(auth(adminToken))
      .send({
        name: `T ${suffix} ${tournamentIds.length}`,
        buyIn: 1000,
        entryFee: 100,
        startingStack: 20_000,
        blinds,
        lateRegUntilLevel: 4,
        ...over,
      });
    expect(res.status).toBe(201);
    tournamentIds.push(res.body.id);
    return res.body.id;
  };

  it('only an admin can create a tournament, and the config is validated', async () => {
    await request(server)
      .post('/api/tournaments')
      .set(auth(tokens[0]!))
      .send({ name: 'nope', buyIn: 1000, startingStack: 20_000, blinds })
      .expect(403);

    await request(server)
      .post('/api/tournaments')
      .set(auth(adminToken))
      .send({
        name: 'bad',
        buyIn: 1000,
        startingStack: 20_000,
        blinds,
        seatsPerTable: 9,
        gameType: 'OMAHA5_HILO',
      })
      .expect(400); // Big O only fits eight per table
  });

  it('a player registers, the buy-in + fee leaves their wallet, and they show up in the field', async () => {
    const id = await create();
    const before = await balance(0);

    const res = await request(server)
      .post(`/api/tournaments/${id}/register`)
      .set(auth(tokens[0]!))
      .expect(201);

    expect(res.body.entrantCount).toBe(1);
    expect(res.body.you.username).toBe(players[0]!.username);
    expect(res.body.prizePool).toBe(1000); // one buy-in, the fee is the house's
    expect(await balance(0)).toBe(before - 1100);
  });

  it('registering twice is a conflict', async () => {
    const id = await create();
    await request(server).post(`/api/tournaments/${id}/register`).set(auth(tokens[1]!)).expect(201);
    await request(server).post(`/api/tournaments/${id}/register`).set(auth(tokens[1]!)).expect(409);
  });

  it('unregistering before the start refunds the wallet in full', async () => {
    const id = await create();
    const before = await balance(2);
    await request(server).post(`/api/tournaments/${id}/register`).set(auth(tokens[2]!)).expect(201);
    expect(await balance(2)).toBe(before - 1100);

    const res = await request(server)
      .delete(`/api/tournaments/${id}/register`)
      .set(auth(tokens[2]!))
      .expect(200);
    expect(res.body.entrantCount).toBe(0);
    expect(res.body.you).toBeNull();
    expect(await balance(2)).toBe(before);

    // re-registering charges the wallet again (a fresh idempotency key)
    await request(server).post(`/api/tournaments/${id}/register`).set(auth(tokens[2]!)).expect(201);
    expect(await balance(2)).toBe(before - 1100);
  });

  it('honours the entrant cap', async () => {
    const id = await create({ maxEntrants: 2 });
    await request(server).post(`/api/tournaments/${id}/register`).set(auth(tokens[0]!)).expect(201);
    await request(server).post(`/api/tournaments/${id}/register`).set(auth(tokens[1]!)).expect(201);
    await request(server).post(`/api/tournaments/${id}/register`).set(auth(tokens[2]!)).expect(400);
  });

  it('cancelling a tournament refunds every entrant', async () => {
    const id = await create();
    const before = [await balance(0), await balance(1)];
    await request(server).post(`/api/tournaments/${id}/register`).set(auth(tokens[0]!)).expect(201);
    await request(server).post(`/api/tournaments/${id}/register`).set(auth(tokens[1]!)).expect(201);

    const res = await request(server)
      .patch(`/api/tournaments/${id}/status`)
      .set(auth(adminToken))
      .send({ status: 'CANCELLED' })
      .expect(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(await balance(0)).toBe(before[0]);
    expect(await balance(1)).toBe(before[1]);

    // a cancelled tournament is hidden from the list
    const list = await request(server).get('/api/tournaments').set(auth(tokens[0]!)).expect(200);
    expect(list.body.some((t: { id: string }) => t.id === id)).toBe(false);
  });

  it('opens registration on the admin transition', async () => {
    const id = await create();
    const res = await request(server)
      .patch(`/api/tournaments/${id}/status`)
      .set(auth(adminToken))
      .send({ status: 'REGISTERING' })
      .expect(200);
    expect(res.body.status).toBe('REGISTERING');
  });
});
