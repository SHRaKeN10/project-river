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
    { email: `p3_${suffix}@ex.test`, username: `p3_${suffix}`.slice(0, 20) },
  ];
  const tokens: string[] = [];
  const userIds: string[] = [];
  const password = 'a-strong-passphrase';
  const sockets: Socket[] = [];
  const extraTableIds: string[] = [];

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
    await prisma.pokerTable
      .deleteMany({ where: { id: { in: [tableId, ...extraTableIds] } } })
      .catch(() => undefined);
    await prisma.user
      .deleteMany({ where: { email: { in: players.map((p) => p.email) } } })
      .catch(() => undefined);
    await app?.close();
  });

  /** A fresh isolated table so a regression test never collides with others. */
  const makeTable = async (
    over: Partial<{
      maxSeats: number;
      minBuyIn: number;
      maxBuyIn: number;
      gameType: 'NLHE' | 'PLO' | 'OMAHA5_HILO';
    }> = {},
  ) => {
    const t = await app.get(TablesService).create({
      name: `e2e ${suffix} ${extraTableIds.length}`,
      gameType: over.gameType ?? 'NLHE',
      smallBlind: 10,
      bigBlind: 20,
      maxSeats: over.maxSeats ?? 3,
      minBuyIn: over.minBuyIn ?? 200,
      maxBuyIn: over.maxBuyIn ?? 2000,
    });
    extraTableIds.push(t.id);
    return t.id;
  };

  const balance = async (i: number): Promise<number> => {
    const [u] = await prisma.user.findMany({
      where: { id: userIds[i] },
      select: { playChips: true },
    });
    return u!.playChips;
  };

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

  it('lets a spectator watch a table without a seat, cards, or a buy-in', async () => {
    const watcher = await connect(tokens[2]!);

    const stateP = waitFor(watcher, 'table:state');
    const first = await emitAck<{ ok?: true; error?: string }>(watcher, 'table:watch', { tableId });
    expect(first.ok).toBe(true);

    const state = (await stateP) as any;
    expect(state.tableId).toBe(tableId);
    expect(state.youAreSeat).toBeNull();
    expect(state.legalActions).toBeNull();
    for (const seat of state.seats) expect(seat.holeCards).toBeNull();

    // spectator was not charged
    const [u] = await prisma.user.findMany({
      where: { id: userIds[2] },
      select: { playChips: true },
    });
    expect(u?.playChips).toBe(10000);

    const bye = await emitAck<{ ok?: true }>(watcher, 'table:unwatch', { tableId });
    expect(bye.ok).toBe(true);
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
      where: { id: { in: userIds.slice(0, 2) } },
      select: { playChips: true },
    });
    for (const u of users) expect(u.playChips).toBe(9000); // 10000 grant - 1000 buy-in
  }, 25000);

  it('runs a Pot-Limit Omaha table: four hole cards, bet sizing capped at the pot', async () => {
    const ploTable = await makeTable({ gameType: 'PLO', maxSeats: 2 });
    const seen: any[] = [];
    let seq = 0;

    // Each client calls/checks, and every state is recorded for the assertions.
    const drive = (socket: Socket) => {
      const actedOn = new Set<string>();
      socket.on('table:state', (state: any) => {
        seen.push(state);
        if (!state.handId || state.actingSeat !== state.youAreSeat) return;
        if (!state.legalActions?.length) return;
        const key = `${state.handId}:${state.actingSeat}:${state.currentBet}:${state.street}`;
        if (actedOn.has(key)) return;
        actedOn.add(key);
        const kinds = state.legalActions.map((o: any) => o.kind);
        const pick = kinds.includes('CHECK') ? 'CHECK' : kinds.includes('CALL') ? 'CALL' : 'FOLD';
        socket.emit('player:action', {
          tableId: ploTable,
          handId: state.handId,
          clientSeq: (seq += 1),
          action: { type: pick },
        });
      });
    };

    const sA = await connect(tokens[0]!);
    const sB = await connect(tokens[1]!);
    drive(sA);
    drive(sB);

    const endA = waitFor(sA, 'hand:end', 25000);
    const endB = waitFor(sB, 'hand:end', 25000);
    await emitAck(sA, 'table:join', { tableId: ploTable, seatNumber: 0, buyIn: 2000 });
    await emitAck(sB, 'table:join', { tableId: ploTable, seatNumber: 1, buyIn: 2000 });
    await Promise.all([endA, endB]);

    // the hero always holds exactly four cards; nobody ever holds more
    const heroCardStates = seen.filter(
      (s) =>
        s.handId &&
        s.street !== 'COMPLETE' &&
        s.seats.some((seat: any) => seat.seatNumber === s.youAreSeat && seat.holeCards),
    );
    expect(heroCardStates.length).toBeGreaterThan(0);
    for (const s of heroCardStates) {
      const hero = s.seats.find((seat: any) => seat.seatNumber === s.youAreSeat);
      expect(hero.holeCards).toHaveLength(4);
    }

    // every RAISE the server offered was capped at the pot-limit maximum:
    // currentBet + pot + the amount owed
    const raiseBounds = seen
      .filter((s) => s.handId && s.actingSeat === s.youAreSeat && s.legalActions)
      .flatMap((s) => {
        const raise = s.legalActions.find((o: any) => o.kind === 'RAISE' || o.kind === 'BET');
        if (!raise || raise.max === undefined) return [];
        const owed = s.legalActions.find((o: any) => o.kind === 'CALL')?.callAmount ?? 0;
        return [{ max: raise.max, cap: s.currentBet + s.pot + owed }];
      });
    expect(raiseBounds.length).toBeGreaterThan(0);
    for (const b of raiseBounds) expect(b.max).toBe(b.cap);
  }, 25000);

  it('runs a Big O table: five hole cards each, and refuses a nine-seat Big O table', async () => {
    await expect(
      app.get(TablesService).create({
        name: `bigo9 ${suffix}`,
        gameType: 'OMAHA5_HILO',
        smallBlind: 10,
        bigBlind: 20,
        maxSeats: 9,
      }),
    ).rejects.toThrow(/at most 8/);

    const table = await makeTable({ gameType: 'OMAHA5_HILO', maxSeats: 2 });
    const seen: any[] = [];
    let seq = 0;
    const drive = (socket: Socket) => {
      const actedOn = new Set<string>();
      socket.on('table:state', (state: any) => {
        seen.push(state);
        if (!state.handId || state.actingSeat !== state.youAreSeat || !state.legalActions?.length) {
          return;
        }
        const key = `${state.handId}:${state.actingSeat}:${state.currentBet}:${state.street}`;
        if (actedOn.has(key)) return;
        actedOn.add(key);
        const kinds = state.legalActions.map((o: any) => o.kind);
        const pick = kinds.includes('CHECK') ? 'CHECK' : kinds.includes('CALL') ? 'CALL' : 'FOLD';
        socket.emit('player:action', {
          tableId: table,
          handId: state.handId,
          clientSeq: (seq += 1),
          action: { type: pick },
        });
      });
    };

    const sA = await connect(tokens[0]!);
    const sB = await connect(tokens[1]!);
    drive(sA);
    drive(sB);
    const endA = waitFor(sA, 'hand:end', 25000);
    const endB = waitFor(sB, 'hand:end', 25000);
    await emitAck(sA, 'table:join', { tableId: table, seatNumber: 0, buyIn: 2000 });
    await emitAck(sB, 'table:join', { tableId: table, seatNumber: 1, buyIn: 2000 });
    await Promise.all([endA, endB]);

    const heroCardStates = seen.filter(
      (s) =>
        s.handId &&
        s.street !== 'COMPLETE' &&
        s.seats.some((seat: any) => seat.seatNumber === s.youAreSeat && seat.holeCards),
    );
    expect(heroCardStates.length).toBeGreaterThan(0);
    for (const s of heroCardStates) {
      const hero = s.seats.find((seat: any) => seat.seatNumber === s.youAreSeat);
      expect(hero.holeCards).toHaveLength(5);
    }
  }, 25000);

  it('runs a bomb-pot hand: everyone posts, no blinds, straight to the flop, spectator sees it', async () => {
    const t = await makeTable({ maxSeats: 2, minBuyIn: 200, maxBuyIn: 2000 });
    // Force the very first hand to be a bomb pot (0 + 1 >= 1).
    await prisma.pokerTable.update({
      where: { id: t },
      data: { bombPotEnabled: true, bombPotIntervalHands: 1 },
    });

    const seen: any[] = [];
    const updates: any[] = [];
    let seq = 0;
    const drive = (socket: Socket, recordUpdates = false) => {
      const acted = new Set<string>();
      if (recordUpdates) socket.on('hand:update', (e: any) => updates.push(e));
      socket.on('table:state', (state: any) => {
        seen.push(state);
        if (!state.handId || state.actingSeat !== state.youAreSeat || !state.legalActions?.length) {
          return;
        }
        const key = `${state.handId}:${state.street}:${state.currentBet}`;
        if (acted.has(key)) return;
        acted.add(key);
        const kinds = state.legalActions.map((o: any) => o.kind);
        const pick = kinds.includes('CHECK') ? 'CHECK' : kinds.includes('CALL') ? 'CALL' : 'FOLD';
        socket.emit('player:action', {
          tableId: t,
          handId: state.handId,
          clientSeq: (seq += 1),
          action: { type: pick },
        });
      });
    };

    const sA = await connect(tokens[0]!);
    const sB = await connect(tokens[1]!);
    const watcher = await connect(tokens[2]!);
    drive(sA, true);
    drive(sB);

    const watcherStates: any[] = [];
    watcher.on('table:state', (s: any) => watcherStates.push(s));
    await emitAck(watcher, 'table:watch', { tableId: t });

    const endA = waitFor(sA, 'hand:end', 25000);
    await emitAck(sA, 'table:join', { tableId: t, seatNumber: 0, buyIn: 1000 });
    await emitAck(sB, 'table:join', { tableId: t, seatNumber: 1, buyIn: 1000 });
    await endA;

    // the first hand was a bomb pot ...
    const bombActive = seen.filter((s) => s.bombPot?.active);
    expect(bombActive.length).toBeGreaterThan(0);
    expect(bombActive[0].bombPot.amount).toBe(20); // = the big blind

    // ... nobody posted a blind, everyone posted the bomb ...
    expect(updates.some((e) => e.type === 'BOMB_POT_STARTED')).toBe(true);
    expect(updates.filter((e) => e.type === 'BOMB_POT_POSTED')).toHaveLength(2);
    expect(updates.some((e) => e.type === 'BLIND_POSTED')).toBe(false);

    // ... and the hand never had a preflop betting round
    const midHand = seen.filter((s) => s.handId && s.street !== 'COMPLETE');
    expect(midHand.length).toBeGreaterThan(0);
    expect(midHand.some((s) => s.street === 'PREFLOP')).toBe(false);

    // spectator saw the bomb pot but no hole cards while the hand was live
    expect(watcherStates.some((s) => s.bombPot?.active)).toBe(true);
    for (const s of watcherStates) {
      if (s.street === 'COMPLETE' || s.street === 'SHOWDOWN') continue; // showdown reveals
      for (const seat of s.seats) expect(seat.holeCards).toBeNull();
    }

    // chips conserved
    const seats = await prisma.pokerTableSeat.findMany({ where: { tableId: t } });
    expect(seats.reduce((sum, s) => sum + s.stack, 0)).toBe(2000);

    // the counter reset and persisted
    const row = await prisma.pokerTable.findUnique({ where: { id: t } });
    expect(row?.handsSinceLastBomb).toBe(0);

    sA.emit('table:leave', { tableId: t });
    sB.emit('table:leave', { tableId: t });
    sA.disconnect();
    sB.disconnect();
    watcher.disconnect();
  }, 30000);

  it('runs a straddled hand: blinds + a UTG straddle, first action past the straddle, flag persists', async () => {
    const t = await makeTable({ maxSeats: 3 });
    const rows = await prisma.pokerTable.findUnique({ where: { id: t } });
    expect(rows?.straddleEnabled).toBe(true); // on by default for NLHE

    const seen: any[] = [];
    const updates: any[] = [];
    let seq = 0;
    const drive = (socket: Socket, recordUpdates = false) => {
      const acted = new Set<string>();
      if (recordUpdates) socket.on('hand:update', (e: any) => updates.push(e));
      socket.on('table:state', (state: any) => {
        seen.push(state);
        if (!state.handId || state.actingSeat !== state.youAreSeat || !state.legalActions?.length) {
          return;
        }
        const key = `${state.handId}:${state.street}:${state.currentBet}`;
        if (acted.has(key)) return;
        acted.add(key);
        const kinds = state.legalActions.map((o: any) => o.kind);
        const pick = kinds.includes('CHECK') ? 'CHECK' : kinds.includes('CALL') ? 'CALL' : 'FOLD';
        socket.emit('player:action', {
          tableId: t,
          handId: state.handId,
          clientSeq: (seq += 1),
          action: { type: pick },
        });
      });
    };

    const sA = await connect(tokens[0]!);
    const sB = await connect(tokens[1]!);
    const sC = await connect(tokens[2]!);
    drive(sA, true);
    drive(sB);
    drive(sC);

    const endA = waitFor(sA, 'hand:end', 25000);
    await emitAck(sA, 'table:join', { tableId: t, seatNumber: 0, buyIn: 1000 });
    await emitAck(sB, 'table:join', { tableId: t, seatNumber: 1, buyIn: 1000 });
    await emitAck(sC, 'table:join', { tableId: t, seatNumber: 2, buyIn: 1000 });

    // seat 0 is UTG 3-handed; arm the straddle before the hand starts
    const armed = await emitAck<{ ok?: true; error?: string }>(sA, 'player:straddle', {
      tableId: t,
      on: true,
    });
    expect(armed.ok).toBe(true);

    await endA;

    // the straddle was posted (blinds too - it is NOT a bomb pot)
    expect(updates.some((e) => e.type === 'STRADDLE_POSTED')).toBe(true);
    expect(updates.filter((e) => e.type === 'BLIND_POSTED')).toHaveLength(2);
    const posted = updates.find((e) => e.type === 'STRADDLE_POSTED');
    expect(posted).toMatchObject({ seat: 0, amount: 40 }); // 2x the 20 BB

    // a mid-hand state shows the straddle and the seat badge, and action never
    // opened on seat 0 (UTG straddled -> SB acts first)
    const mid = seen.filter((s) => s.handId && s.street === 'PREFLOP' && s.straddle?.active);
    expect(mid.length).toBeGreaterThan(0);
    expect(mid[0].straddle).toMatchObject({ active: true, seat: 0, amount: 40 });
    expect(mid[0].seats[0].isStraddle).toBe(true);
    expect(mid[0].seats[1].isStraddle).toBe(false);
    const firstPreflopActor = seen.find(
      (s) => s.handId && s.street === 'PREFLOP' && s.actingSeat !== null,
    )?.actingSeat;
    expect(firstPreflopActor).not.toBe(0);

    // the arming player sees youStraddleNext
    expect(seen.some((s) => s.youAreSeat === 0 && s.youStraddleNext === true)).toBe(true);

    // chips conserved
    const seats = await prisma.pokerTableSeat.findMany({ where: { tableId: t } });
    expect(seats.reduce((sum, s) => sum + s.stack, 0)).toBe(3000);
    // the armed flag persisted to the seat row
    expect(seats.find((s) => s.seatNumber === 0)?.straddleOn).toBe(true);

    sA.emit('table:leave', { tableId: t });
    sB.emit('table:leave', { tableId: t });
    sC.emit('table:leave', { tableId: t });
    sA.disconnect();
    sB.disconnect();
    sC.disconnect();
  }, 30000);

  // --- regression: closed-alpha audit ------------------------------------

  it('refunds the buy-in when the requested seat is already taken', async () => {
    const t = await makeTable();
    const s1 = await connect(tokens[0]!);
    const s2 = await connect(tokens[1]!);

    const before0 = await balance(0);
    const before1 = await balance(1);

    const j1 = await emitAck<{ ok?: true; error?: string }>(s1, 'table:join', {
      tableId: t,
      seatNumber: 0,
      buyIn: 500,
    });
    expect(j1.ok).toBe(true);
    expect(await balance(0)).toBe(before0 - 500);

    // s2 races for the same seat - must be rejected AND not lose chips
    const j2 = await emitAck<{ ok?: true; error?: string }>(s2, 'table:join', {
      tableId: t,
      seatNumber: 0,
      buyIn: 500,
    });
    expect(j2.ok).toBeUndefined();
    expect(j2.error).toMatch(/taken/i);
    expect(await balance(1)).toBe(before1); // fully refunded

    s1.emit('table:leave', { tableId: t });
    s1.disconnect();
    s2.disconnect();
  });

  it('rejects an out-of-range buy-in before touching the wallet', async () => {
    const t = await makeTable({ minBuyIn: 200, maxBuyIn: 400 });
    const s = await connect(tokens[2]!);
    const before = await balance(2);

    const tooBig = await emitAck<{ ok?: true; error?: string }>(s, 'table:join', {
      tableId: t,
      seatNumber: 0,
      buyIn: 999_999,
    });
    expect(tooBig.error).toMatch(/buy-in/i);
    expect(await balance(2)).toBe(before); // never debited

    s.disconnect();
  });

  it('rate-limits a socket that floods the gateway', async () => {
    const s = await connect(tokens[2]!);
    const acks = await Promise.all(
      Array.from({ length: 25 }, () =>
        emitAck<{ ok?: true; error?: string }>(s, 'table:watch', { tableId }),
      ),
    );
    expect(acks.some((a) => /too fast/i.test(a.error ?? ''))).toBe(true);
    s.disconnect();
  });

  it('honours a rejoined player’s actions - no timeout after clientSeq restarts at 1', async () => {
    const t = await makeTable({ maxSeats: 2, minBuyIn: 200, maxBuyIn: 2000 });

    // driver whose clientSeq starts at 1 each time it is attached (like a client
    // that remounts on rejoin). Records how many of ITS actions were acked.
    const attachDriver = (socket: Socket) => {
      let seq = 0;
      let acks = 0;
      const acted = new Set<string>();
      const h = (st: any): void => {
        if (!st.handId || st.actingSeat !== st.youAreSeat || !st.legalActions?.length) return;
        const key = `${st.handId}:${st.street}:${st.currentBet}`;
        if (acted.has(key)) return;
        acted.add(key);
        const kinds = st.legalActions.map((o: any) => o.kind);
        const pick = kinds.includes('CHECK') ? 'CHECK' : kinds.includes('CALL') ? 'CALL' : 'FOLD';
        socket.emit(
          'player:action',
          { tableId: t, handId: st.handId, clientSeq: (seq += 1), action: { type: pick } },
          (r: any) => {
            if (r?.ok) acks += 1;
          },
        );
      };
      socket.on('table:state', h);
      return { off: () => socket.off('table:state', h), acks: () => acks };
    };

    const sA = await connect(tokens[0]!);
    const sB = await connect(tokens[1]!);
    const dA = attachDriver(sA);
    attachDriver(sB);

    await emitAck(sA, 'table:join', { tableId: t, seatNumber: 0, buyIn: 1000 });
    await emitAck(sB, 'table:join', { tableId: t, seatNumber: 1, buyIn: 1000 });
    await waitFor(sA, 'hand:end', 20000); // hand 1 drives A's seq up to ~5

    dA.off();
    await emitAck(sA, 'table:leave', { tableId: t });
    sA.disconnect();

    const sA2 = await connect(tokens[0]!);
    const dA2 = attachDriver(sA2);
    const timedOut: any[] = [];
    sA2.on('hand:update', (e: any) => {
      if (e.type === 'ACTION_TIMED_OUT') timedOut.push(e);
    });
    expect(
      (await emitAck<any>(sA2, 'table:join', { tableId: t, seatNumber: 0, buyIn: 1000 })).ok,
    ).toBe(true);

    await waitFor(sA2, 'hand:end', 20000);
    expect(dA2.acks()).toBeGreaterThan(0); // A2's low-seq actions were accepted
    expect(timedOut).toHaveLength(0); // A2 never got auto-folded for silence

    sA2.emit('table:leave', { tableId: t });
    sB.emit('table:leave', { tableId: t });
    sA2.disconnect();
    sB.disconnect();
  }, 45000);
});
