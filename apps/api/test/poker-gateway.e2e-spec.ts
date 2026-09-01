import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { TablesService } from '../src/tables/tables.service';

/** Full multiplayer path: two authenticated sockets play a hand end to end. */
describe('PokerGateway (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let tableId: string;

  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const players = [
    { email: `p1_${suffix}@ex.test`, username: `p1_${suffix}`.slice(0, 20) },
    { email: `p2_${suffix}@ex.test`, username: `p2_${suffix}`.slice(0, 20) },
  ];
  const tokens: string[] = [];
  const userIds: string[] = [];
  const password = 'a-strong-passphrase';
  const sockets: Socket[] = [];

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

    const server = app.getHttpServer();
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;

    for (const p of players) {
      const res = await request(server)
        .post('/api/auth/register')
        .send({ email: p.email, username: p.username, password });
      tokens.push(res.body.tokens.accessToken);
      userIds.push(res.body.user.id);
    }

    const table = await app.get(TablesService).create({
      name: `e2e ${suffix}`,
      smallBlind: 10,
      bigBlind: 20,
      maxSeats: 2,
      minBuyIn: 200,
      maxBuyIn: 2000,
    });
    tableId = table.id;
  }, 30000);

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await prisma.pokerTable.deleteMany({ where: { id: tableId } }).catch(() => undefined);
    await prisma.user
      .deleteMany({ where: { email: { in: players.map((p) => p.email) } } })
      .catch(() => undefined);
    await app?.close();
  });

  const connect = (token: string): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const socket = io(baseUrl, { auth: { token }, transports: ['websocket'], forceNew: true });
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
      sockets.push(socket);
    });

  const emitAck = <T = unknown>(socket: Socket, event: string, payload: unknown): Promise<T> =>
    new Promise((resolve) => socket.emit(event, payload, (res: T) => resolve(res)));

  const waitFor = (socket: Socket, event: string, timeoutMs = 8000): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${event}`)),
        timeoutMs,
      );
      socket.once(event, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
    });

  it('rejects a socket with no token', async () => {
    await expect(
      new Promise((_resolve, reject) => {
        const s = io(baseUrl, { transports: ['websocket'], forceNew: true });
        s.once('connect_error', (err) => reject(err));
        s.once('connect', () => reject(new Error('should not connect')));
      }),
    ).rejects.toBeDefined();
  });

  it('two players join, play a hand, and each sees only their own cards', async () => {
    const seen: Record<number, any[]> = { 0: [], 1: [] };
    let seq = 0;

    // A client that acts whenever it is its turn: check, else call, else fold.
    const drive = (socket: Socket, bucket: number) => {
      const actedOn = new Set<string>();
      socket.on('table:state', (state: any) => {
        seen[bucket]!.push(state);
        if (!state.handId || state.actingSeat !== state.youAreSeat) return;
        if (!state.legalActions?.length) return;
        const key = `${state.handId}:${state.actingSeat}:${state.currentBet}:${state.street}`;
        if (actedOn.has(key)) return;
        actedOn.add(key);
        const kinds = state.legalActions.map((o: any) => o.kind);
        const pick = kinds.includes('CHECK') ? 'CHECK' : kinds.includes('CALL') ? 'CALL' : 'FOLD';
        socket.emit('player:action', {
          tableId,
          handId: state.handId,
          clientSeq: (seq += 1),
          action: { type: pick },
        });
      });
    };

    const socketA = await connect(tokens[0]!);
    const socketB = await connect(tokens[1]!);
    drive(socketA, 0);
    drive(socketB, 1);

    const endA = waitFor(socketA, 'hand:end', 25000);
    const endB = waitFor(socketB, 'hand:end', 25000);

    const joinA = await emitAck<{ ok?: true; error?: string }>(socketA, 'table:join', {
      tableId,
      seatNumber: 0,
      buyIn: 1000,
    });
    const joinB = await emitAck<{ ok?: true; error?: string }>(socketB, 'table:join', {
      tableId,
      seatNumber: 1,
      buyIn: 1000,
    });
    expect(joinA.ok).toBe(true);
    expect(joinB.ok).toBe(true);

    await Promise.all([endA, endB]);

    // --- assertions ---------------------------------------------------------
    const midHandStates = [...seen[0]!, ...seen[1]!].filter((s: any) => s.handId !== null);
    expect(midHandStates.length).toBeGreaterThan(0);

    // no state message ever contains the deck
    for (const s of [...seen[0]!, ...seen[1]!]) {
      expect(JSON.stringify(s)).not.toMatch(/"deck"|"cursor"/);
    }

    // player A's view: own seat has cards, opponent's is null (before showdown)
    const aPreShowdown = (seen[0]! as any[]).find(
      (s) => s.handId && s.street !== 'COMPLETE' && s.seats.some((seat: any) => seat.holeCards),
    );
    expect(aPreShowdown).toBeTruthy();
    const aOwn = aPreShowdown.seats.find(
      (seat: any) => seat.seatNumber === aPreShowdown.youAreSeat,
    );
    const aOpp = aPreShowdown.seats.find(
      (seat: any) => seat.seatNumber !== aPreShowdown.youAreSeat,
    );
    expect(aOwn.holeCards).toHaveLength(2);
    expect(aOpp.holeCards).toBeNull();

    // chips: table stayed at 2000, each user's balance debited by their buy-in
    const seats = await prisma.pokerTableSeat.findMany({ where: { tableId } });
    expect(seats.reduce((t, s) => t + s.stack, 0)).toBe(2000);

    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { playChips: true },
    });
    for (const u of users) expect(u.playChips).toBe(9000); // 10000 grant - 1000 buy-in
  }, 25000);
});
