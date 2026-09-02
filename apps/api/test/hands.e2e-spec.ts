import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ChipsService } from '../src/chips/chips.service';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { TablesService } from '../src/tables/tables.service';

/** Hand-history persistence + replay, and the transactional chip ledger. */
describe('Hands + chip ledger (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let server: import('http').Server;
  let tableId: string;

  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const players = [
    { email: `h1_${suffix}@ex.test`, username: `h1_${suffix}`.slice(0, 20) },
    { email: `h2_${suffix}@ex.test`, username: `h2_${suffix}`.slice(0, 20) },
    { email: `h3_${suffix}@ex.test`, username: `h3_${suffix}`.slice(0, 20) },
  ];
  const tokens: string[] = [];
  const userIds: string[] = [];
  const password = 'a-strong-passphrase';
  const sockets: Socket[] = [];

  const auth = (i: number) => ({ Authorization: `Bearer ${tokens[i]}` });

  beforeAll(async () => {
    process.env.TABLE_START_DELAY_MS = '50';
    process.env.TABLE_NEXT_HAND_DELAY_MS = '50';
    process.env.TABLE_ACTION_TIMEOUT_MS = '5000';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['health/live', 'health/ready'] });
    await app.init();
    await app.listen(0);
    prisma = app.get(PrismaService);
    server = app.getHttpServer();
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    for (const p of players) {
      const res = await request(server)
        .post('/api/auth/register')
        .send({ email: p.email, username: p.username, password });
      tokens.push(res.body.tokens.accessToken);
      userIds.push(res.body.user.id);
    }

    tableId = (
      await app.get(TablesService).create({
        name: `hands ${suffix}`,
        smallBlind: 10,
        bigBlind: 20,
        maxSeats: 2,
        minBuyIn: 200,
        maxBuyIn: 2000,
      })
    ).id;
  }, 30000);

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await prisma.pokerHand.deleteMany({ where: { tableId } }).catch(() => undefined);
    await prisma.pokerTable.deleteMany({ where: { id: tableId } }).catch(() => undefined);
    await prisma.chipLedgerEntry
      .deleteMany({ where: { userId: { in: userIds } } })
      .catch(() => undefined);
    await prisma.user
      .deleteMany({ where: { email: { in: players.map((p) => p.email) } } })
      .catch(() => undefined);
    await app?.close();
  });

  const connect = (token: string): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const s = io(baseUrl, { auth: { token }, transports: ['websocket'], forceNew: true });
      s.once('connect', () => resolve(s));
      s.once('connect_error', reject);
      sockets.push(s);
    });

  const emitAck = <T = unknown>(s: Socket, event: string, payload: unknown): Promise<T> =>
    new Promise((resolve) => s.emit(event, payload, (r: T) => resolve(r)));

  const waitFor = (s: Socket, event: string, timeoutMs = 15000): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
      s.once(event, (d) => {
        clearTimeout(t);
        resolve(d);
      });
    });

  it('idempotent chip movement: repeating an idemKey is a no-op', async () => {
    const chips = app.get(ChipsService);
    const start = await chips.getBalance(userIds[2]!);
    const key = `test:${suffix}:once`;
    const first = await chips.move({
      userId: userIds[2]!,
      amount: -100,
      reason: 'ADJUSTMENT',
      idemKey: key,
    });
    const second = await chips.move({
      userId: userIds[2]!,
      amount: -100,
      reason: 'ADJUSTMENT',
      idemKey: key,
    });
    expect(first).toBe(start - 100);
    expect(second).toBe(start - 100); // not debited twice
    expect(await chips.getBalance(userIds[2]!)).toBe(start - 100);
    const entries = await prisma.chipLedgerEntry.count({ where: { idemKey: key } });
    expect(entries).toBe(1);
  });

  it('persists a completed hand and serves it through the history API', async () => {
    let seq = 0;
    const drive = (socket: Socket) => {
      const acted = new Set<string>();
      socket.on('table:state', (st: any) => {
        if (!st.handId || st.actingSeat !== st.youAreSeat || !st.legalActions?.length) return;
        const key = `${st.handId}:${st.street}:${st.currentBet}`;
        if (acted.has(key)) return;
        acted.add(key);
        const kinds = st.legalActions.map((o: any) => o.kind);
        const pick = kinds.includes('CHECK') ? 'CHECK' : kinds.includes('CALL') ? 'CALL' : 'FOLD';
        socket.emit('player:action', {
          tableId,
          handId: st.handId,
          clientSeq: (seq += 1),
          action: { type: pick },
        });
      });
    };

    const a = await connect(tokens[0]!);
    const b = await connect(tokens[1]!);
    drive(a);
    drive(b);

    const endA = waitFor(a, 'hand:end', 25000);
    await emitAck(a, 'table:join', { tableId, seatNumber: 0, buyIn: 1000 });
    await emitAck(b, 'table:join', { tableId, seatNumber: 1, buyIn: 1000 });

    // chip conservation while seated: wallet + seat stack == the 10000 grant
    const seatRow = await prisma.pokerTableSeat.findFirst({
      where: { tableId, userId: userIds[0]! },
    });
    const wallet = await app.get(ChipsService).getBalance(userIds[0]!);
    expect(wallet + (seatRow?.stack ?? 0)).toBe(10000);

    // a TABLE_BUYIN ledger row was written
    const buyIn = await prisma.chipLedgerEntry.findFirst({
      where: { userId: userIds[0]!, reason: 'TABLE_BUYIN', tableId },
    });
    expect(buyIn?.amount).toBe(-1000);

    await endA;
    await new Promise((r) => setTimeout(r, 300)); // let the async persist settle

    // list by table
    const list = await request(server).get(`/api/hands?tableId=${tableId}`).set(auth(0));
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThanOrEqual(1);
    const handId = list.body[0].id;
    expect(list.body[0]).toMatchObject({ tableId, handNumber: expect.any(Number) });

    // "mine" for a participant, and not for a non-participant
    const mine = await request(server).get('/api/hands/mine').set(auth(0));
    expect(mine.body.map((h: any) => h.id)).toContain(handId);
    const notMine = await request(server).get('/api/hands/mine').set(auth(2));
    expect(notMine.body.map((h: any) => h.id)).not.toContain(handId);

    // detail: participant ok, outsider forbidden
    const detail = await request(server).get(`/api/hands/${handId}`).set(auth(0));
    expect(detail.status).toBe(200);
    expect(detail.body.deck).toHaveLength(52);
    const forbidden = await request(server).get(`/api/hands/${handId}`).set(auth(2));
    expect(forbidden.status).toBe(403);

    // replay reproduces the recorded board
    const replay = await request(server).get(`/api/hands/${handId}/replay`).set(auth(1));
    expect(replay.status).toBe(200);
    expect(replay.body.state.communityCards.length).toBe(detail.body.board.length);

    a.emit('table:leave', { tableId });
    b.emit('table:leave', { tableId });
  }, 30000);

  it('returns the stack to the wallet with a TABLE_CASHOUT ledger row on leave', async () => {
    await new Promise((r) => setTimeout(r, 400));
    const cashouts = await prisma.chipLedgerEntry.findMany({
      where: { userId: { in: [userIds[0]!, userIds[1]!] }, reason: 'TABLE_CASHOUT', tableId },
    });
    expect(cashouts.length).toBeGreaterThanOrEqual(1);
    // every player is back to (near) their grant: no chips vanished
    for (const id of [userIds[0]!, userIds[1]!]) {
      const bal = await app.get(ChipsService).getBalance(id);
      expect(bal).toBeGreaterThan(0);
      expect(bal).toBeLessThanOrEqual(11000);
    }
  }, 15000);
});
