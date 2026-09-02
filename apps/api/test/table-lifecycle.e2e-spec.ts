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
 * Disconnect really reaches the runner (it used to be lost because
 * `socket.rooms` is already empty in `handleDisconnect`), and an emptied table
 * is dropped from memory rather than lingering forever.
 */
describe('Table lifecycle (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let manager: TableManager;
  let baseUrl: string;

  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const players = [
    { email: `lc1_${suffix}@ex.test`, username: `lc1_${suffix}`.slice(0, 20) },
    { email: `lc2_${suffix}@ex.test`, username: `lc2_${suffix}`.slice(0, 20) },
  ];
  const tokens: string[] = [];
  const userIds: string[] = [];
  const password = 'a-strong-passphrase';
  const sockets: Socket[] = [];
  const tableIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['health/live', 'health/ready'] });
    await app.init();
    await app.listen(0);
    prisma = app.get(PrismaService);
    manager = app.get(TableManager);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    for (const p of players) {
      const res = await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({ email: p.email, username: p.username, password });
      tokens.push(res.body.tokens.accessToken);
      userIds.push(res.body.user.id);
    }
  }, 30000);

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await prisma.pokerTable.deleteMany({ where: { id: { in: tableIds } } }).catch(() => undefined);
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

  const makeTable = async (): Promise<string> => {
    const t = await app.get(TablesService).create({
      name: `lc ${suffix} ${tableIds.length}`,
      smallBlind: 10,
      bigBlind: 20,
      maxSeats: 3,
      minBuyIn: 200,
      maxBuyIn: 2000,
    });
    tableIds.push(t.id);
    return t.id;
  };

  const settle = () => new Promise((r) => setTimeout(r, 250));

  it('a hard socket drop marks the seated player disconnected in the runner', async () => {
    const tableId = await makeTable();
    const a = await connect(tokens[0]!);
    const b = await connect(tokens[1]!);
    await emitAck(a, 'table:join', { tableId, seatNumber: 0, buyIn: 800 });
    await emitAck(b, 'table:join', { tableId, seatNumber: 1, buyIn: 800 });
    await settle();

    const runner = manager.getRunner(tableId)!;
    expect(runner.rosterEntries.get(0)?.connected).toBe(true);

    a.disconnect();
    await settle();

    // the fix: this used to stay `true` forever (socket.rooms already cleared)
    expect(runner.rosterEntries.get(0)?.connected).toBe(false);
    expect(runner.rosterEntries.get(1)?.connected).toBe(true);

    b.emit('table:leave', { tableId });
    b.disconnect();
  }, 20000);

  it('a reconnect (via watch) marks the player present again', async () => {
    const tableId = await makeTable();
    const s1 = await connect(tokens[0]!);
    const s2 = await connect(tokens[1]!);
    await emitAck(s1, 'table:join', { tableId, seatNumber: 0, buyIn: 800 });
    await emitAck(s2, 'table:join', { tableId, seatNumber: 1, buyIn: 800 });
    await settle();

    s1.disconnect();
    await settle();
    const runner = manager.getRunner(tableId)!;
    expect(runner.rosterEntries.get(0)?.connected).toBe(false);

    const s1b = await connect(tokens[0]!);
    await emitAck(s1b, 'table:watch', { tableId });
    await settle();
    expect(runner.rosterEntries.get(0)?.connected).toBe(true);

    s1b.emit('table:leave', { tableId });
    s2.emit('table:leave', { tableId });
    s1b.disconnect();
    s2.disconnect();
  }, 20000);

  it('schedules an idle table for reaping once its last player leaves, and a rejoin cancels it', async () => {
    const tableId = await makeTable();
    const s = await connect(tokens[0]!);
    await emitAck(s, 'table:join', { tableId, seatNumber: 0, buyIn: 800 });
    await settle();
    expect(manager.getRunner(tableId)).toBeDefined();
    expect(manager.isIdleReapScheduled(tableId)).toBe(false);

    await emitAck(s, 'table:leave', { tableId });
    await settle();

    // deferred, not synchronous: the runner lingers on a grace timer so a
    // concurrent join can't be disposed out from under it
    const runner = manager.getRunner(tableId);
    expect(runner).toBeDefined();
    expect(runner!.isEmpty()).toBe(true);
    expect(manager.isIdleReapScheduled(tableId)).toBe(true);

    // touching the table again (a re-visit) cancels the pending reap
    const s2 = await connect(tokens[1]!);
    await emitAck(s2, 'table:watch', { tableId });
    await settle();
    expect(manager.getRunner(tableId)).toBe(runner);
    expect(manager.isIdleReapScheduled(tableId)).toBe(false);

    s.disconnect();
    s2.disconnect();
  }, 20000);

  it('a closed table cannot be re-joined through the gateway', async () => {
    const tableId = await makeTable();
    const s = await connect(tokens[0]!);
    await emitAck(s, 'table:join', { tableId, seatNumber: 0, buyIn: 800 });
    await settle();

    await manager.closeTable(tableId);
    await app.get(TablesService).setStatus(tableId, 'CLOSED');

    const rejoin = await emitAck<{ ok?: true; error?: string }>(s, 'table:join', {
      tableId,
      seatNumber: 0,
      buyIn: 800,
    });
    expect(rejoin.ok).toBeUndefined();
    expect(rejoin.error).toBeTruthy();
    expect(manager.getRunner(tableId)).toBeUndefined();
    s.disconnect();
  }, 20000);
});
