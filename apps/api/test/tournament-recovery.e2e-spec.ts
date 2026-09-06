import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { standardBlindSchedule } from '@river/poker-engine';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { TournamentManager } from '../src/tournaments/tournament-manager';
import type { TournamentRunner } from '../src/tournaments/tournament-runner';
import { TournamentsService } from '../src/tournaments/tournaments.service';

/**
 * Restart recovery, end to end (ADR-0025). A running tournament survives the
 * API process going away: the DB row stays RUNNING, the Redis checkpoint holds
 * the runtime state, and on boot the coordinator + every table are rehydrated
 * and play continues to a correct finish. No hand is duplicated or skipped;
 * chips are conserved; a client reconnects and carries on.
 */
describe('Tournament restart recovery (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let tournaments: TournamentsService;
  let manager: TournamentManager;
  let baseUrl: string;

  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const N = 6;
  const players = Array.from({ length: N }, (_, i) => ({
    email: `rc${i}_${suffix}@ex.test`,
    username: `rc${i}_${suffix}`.slice(0, 20),
  }));
  const password = 'a-strong-passphrase';
  const tokens: string[] = [];
  const userIds: string[] = [];
  const openSockets: Socket[] = [];
  const tournamentIds: string[] = [];

  const blinds = [
    ...standardBlindSchedule({ startingBigBlind: 20, levelDurationMs: 1_500, levels: 12 }),
  ];

  beforeAll(async () => {
    process.env.TABLE_NEXT_HAND_DELAY_MS = '25';
    process.env.TABLE_ACTION_TIMEOUT_MS = '3000';
    process.env.TABLE_DISCONNECT_GRACE_MS = '1500';

    app = await buildApp();
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    tournaments = app.get(TournamentsService);
    manager = app.get(TournamentManager);
    baseUrl = urlOf(app);

    const server = app.getHttpServer();
    for (const p of players) {
      const res = await request(server)
        .post('/api/auth/register')
        .send({ ...p, password });
      tokens.push(res.body.tokens.accessToken);
      userIds.push(res.body.user.id);
    }
  }, 40000);

  afterAll(async () => {
    for (const s of openSockets) s.disconnect();
    for (const id of tournamentIds) {
      manager.stop(id);
      await redis.client.del(`tournament:${id}:snapshot`).catch(() => {});
    }
    await prisma.tournament.deleteMany({ where: { id: { in: tournamentIds } } }).catch(() => {});
    await prisma.chipLedgerEntry.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await prisma.user
      .deleteMany({ where: { email: { in: players.map((p) => p.email) } } })
      .catch(() => {});
    await app?.close();
  });

  const buildApp = async (): Promise<INestApplication> => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const a = moduleRef.createNestApplication();
    a.setGlobalPrefix('api', { exclude: ['health/live', 'health/ready'] });
    await a.init();
    await a.listen(0);
    return a;
  };
  const urlOf = (a: INestApplication): string =>
    `http://127.0.0.1:${(a.getHttpServer().address() as AddressInfo).port}`;

  const running = async (over: Partial<{ seatsPerTable: number; startingStack: number }> = {}) => {
    const view = await tournaments.create({
      name: `RC ${suffix} ${tournamentIds.length}`,
      buyIn: 100,
      startingStack: over.startingStack ?? 240,
      seatsPerTable: over.seatsPerTable ?? 9,
      blinds,
      lateRegUntilLevel: 1,
    });
    tournamentIds.push(view.id);
    for (let i = 0; i < N; i += 1) await tournaments.register(userIds[i]!, view.id);
    await manager.start(view.id);
    return view.id;
  };

  const connect = (url: string, token: string): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const socket = io(url, { auth: { token }, transports: ['websocket'], forceNew: true });
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
      openSockets.push(socket);
    });

  const emitAck = <T = unknown>(socket: Socket, event: string, payload: unknown): Promise<T> =>
    new Promise((resolve) => socket.emit(event, payload, (res: T) => resolve(res)));

  const waitFor = (socket: Socket, event: string, timeoutMs = 20_000): Promise<any> =>
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

  /** jam bot: attach listeners + auto-ALL_IN, return a collected event log. */
  const drive = (socket: Socket, tournamentId: string) => {
    const c = {
      states: [] as any[],
      eliminated: [] as any[],
      finished: [] as any[],
      clocks: [] as any[],
      errors: [] as any[],
    };
    let seq = 1_000_000;
    const acted = new Set<string>();
    socket.on('table:state', (st: any) => {
      c.states.push(st);
      if (st.tournamentId !== tournamentId) return;
      if (!st.handId || st.actingSeat === null || st.actingSeat !== st.youAreSeat) return;
      if (!st.legalActions?.length) return;
      const key = `${st.handId}:${st.street}:${st.currentBet}:${st.actingSeat}`;
      if (acted.has(key)) return;
      acted.add(key);
      const kinds: string[] = st.legalActions.map((o: any) => o.kind);
      const pick = kinds.includes('ALL_IN')
        ? 'ALL_IN'
        : kinds.includes('CHECK')
          ? 'CHECK'
          : kinds.includes('CALL')
            ? 'CALL'
            : 'FOLD';
      socket.emit('tournament:action', {
        tournamentId,
        handId: st.handId,
        clientSeq: (seq += 1),
        action: { type: pick },
      });
    });
    socket.on('tournament:eliminated', (e: any) => c.eliminated.push(e));
    socket.on('tournament:finished', (e: any) => c.finished.push(e));
    socket.on('tournament:clock', (e: any) => c.clocks.push(e));
    socket.on('error', (e: any) => c.errors.push(e));
    return c;
  };

  const runnerOf = (m: TournamentManager, id: string): TournamentRunner | undefined => m.get(id);
  /** Drop the in-memory runner without touching Redis/DB - the crash the boot
   * scan / `recover` then heals. */
  const evict = (m: TournamentManager, id: string): void => {
    const runners = (m as unknown as { runners: Map<string, TournamentRunner> }).runners;
    runners.get(id)?.dispose();
    runners.delete(id);
  };

  // ---------------------------------------------------------------------

  it('survives a full API process restart and plays on to a correct finish', async () => {
    // deep stacks so the field is still well short of the finish when we pull
    // the plug a couple of seconds in
    const id = await running({ seatsPerTable: 3, startingStack: 6_000 });
    expect(runnerOf(manager, id)!.tableCount).toBe(2);

    const s1 = await Promise.all(tokens.map((t) => connect(baseUrl, t)));
    s1.forEach((s) => drive(s, id));
    await Promise.all(s1.map((s) => emitAck(s, 'tournament:watch', { tournamentId: id })));

    // let a few hands run, then restart mid-tournament
    await new Promise((r) => setTimeout(r, 2_500));

    const before = runnerOf(manager, id);
    expect(before).toBeDefined();
    const chipsBefore = before!.totalChips;
    const standingsBefore = tokens.map((_, i) => before!.entrantView(userIds[i]!));

    // --- restart: tear the whole app down, stand a fresh one up on the same
    // Postgres + Redis. The DB row is still RUNNING; the checkpoint is in Redis.
    for (const s of s1) s.disconnect();
    await app.close();

    app = await buildApp();
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    tournaments = app.get(TournamentsService);
    manager = app.get(TournamentManager);
    baseUrl = urlOf(app);

    // the boot scan (OnApplicationBootstrap) rehydrates it
    let recovered: TournamentRunner | undefined;
    for (let i = 0; i < 100 && !recovered; i += 1) {
      recovered = await manager.ensureRunner(id);
      if (!recovered) await new Promise((r) => setTimeout(r, 100));
    }
    expect(recovered).toBeDefined();
    expect(recovered!.totalChips).toBe(chipsBefore);
    expect(recovered!.totalChips).toBe(6_000 * N);
    // eliminations preserved exactly
    tokens.forEach((_, i) => {
      expect(recovered!.entrantView(userIds[i]!)?.finishPosition).toBe(
        standingsBefore[i]?.finishPosition ?? null,
      );
    });

    // clients reconnect to the new process and play it out
    const s2 = await Promise.all(tokens.map((t) => connect(baseUrl, t)));
    s2.forEach((s) => drive(s, id));
    await Promise.all(s2.map((s) => emitAck(s, 'tournament:watch', { tournamentId: id })));

    const finish: any = await Promise.race(
      s2.map((s) => waitFor(s, 'tournament:finished', 45_000)),
    );
    expect(finish.tournamentId).toBe(id);
    expect(finish.results).toHaveLength(N);
    const positions = finish.results
      .map((r: any) => r.position)
      .sort((a: number, b: number) => a - b);
    expect(positions).toEqual([1, 2, 3, 4, 5, 6]);

    // the DB settled: FINISHED, full standings, payouts sum to the prize pool
    const view = await request(app.getHttpServer())
      .get(`/api/tournaments/${id}`)
      .set({ Authorization: `Bearer ${tokens[0]}` })
      .expect(200);
    expect(view.body.status).toBe('FINISHED');
    const paid = (view.body.results as { payout: number }[]).reduce((t, r) => t + r.payout, 0);
    expect(paid).toBe(view.body.prizePool);
    // nobody was eliminated twice
    const finPos = (view.body.results as { position: number }[]).map((r) => r.position);
    expect(new Set(finPos).size).toBe(finPos.length);

    for (const s of s2) s.disconnect();
  }, 120_000);

  it('recovers a hand in progress on the exact same hand id / street, and a client resumes it', async () => {
    const id = await running({ seatsPerTable: 9, startingStack: 4_000 }); // one table, deep - a slow hand
    const a = await connect(baseUrl, tokens[0]!);
    const b = await connect(baseUrl, tokens[1]!);
    // passive: only the first player jams, so hands run long enough to catch mid-street
    drive(a, id);
    await emitAck(a, 'tournament:watch', { tournamentId: id });
    await emitAck(b, 'tournament:watch', { tournamentId: id });

    const midState: any = await new Promise((resolve) => {
      a.on('table:state', (st: any) => {
        if (st.handId && st.street !== 'COMPLETE' && st.actingSeat !== null) resolve(st);
      });
    });
    const handId = midState.handId;
    const street = midState.street;
    expect(handId).toBeTruthy();

    a.disconnect();
    b.disconnect();
    await new Promise((r) => setTimeout(r, 200));
    evict(manager, id);
    expect(manager.get(id)).toBeUndefined();

    await manager.recover(id);
    const recovered = manager.get(id);
    expect(recovered).toBeDefined();
    const st = recovered!.tableStates()[0]!.state;
    expect(st.handId).toBe(handId); // same hand - not re-dealt
    expect(st.street).toBe(street);

    // a client reconnects and is handed the same hand to continue
    const a2 = await connect(baseUrl, tokens[0]!);
    const resumed: any = await new Promise((resolve) => {
      a2.on('table:state', (s: any) => {
        if (s.tournamentId === id) resolve(s);
      });
      void emitAck(a2, 'tournament:watch', { tournamentId: id });
    });
    expect(resumed.handId).toBe(handId);
    expect(resumed.tournamentId).toBe(id);
    // chip conservation held across the recovery
    expect(recovered!.totalChips).toBe(4_000 * N);
    a2.disconnect();
  }, 60_000);

  it('fails closed when the checkpoint is missing - no runner, row untouched', async () => {
    const id = await running({ seatsPerTable: 9, startingStack: 400 });
    await new Promise((r) => setTimeout(r, 200));

    await redis.client.del(`tournament:${id}:snapshot`);
    evict(manager, id);

    await manager.recover(id);
    expect(manager.get(id)).toBeUndefined(); // no runner spawned

    const row = await prisma.tournament.findUnique({ where: { id } });
    expect(row?.status).toBe('RUNNING'); // left recoverable, not corrupted
  }, 40_000);

  it('a client that reconnects just after the tournament finished is told the outcome', async () => {
    const id = await running({ seatsPerTable: 3, startingStack: 150 });
    const s = await Promise.all(tokens.map((t) => connect(baseUrl, t)));
    s.forEach((sock) => drive(sock, id));
    await Promise.all(s.map((sock) => emitAck(sock, 'tournament:watch', { tournamentId: id })));
    await Promise.race(s.map((sock) => waitFor(sock, 'tournament:finished', 45_000)));
    for (const sock of s) sock.disconnect();
    await new Promise((r) => setTimeout(r, 300));

    // the live runner is gone; a fresh watch still gets the standings from the marker
    const late = await connect(baseUrl, tokens[0]!);
    const finishedP = waitFor(late, 'tournament:finished', 5_000);
    const ack = await emitAck<{ ok?: true; error?: string }>(late, 'tournament:watch', {
      tournamentId: id,
    });
    expect(ack.ok).toBe(true);
    const f = await finishedP;
    expect(f.tournamentId).toBe(id);
    expect(f.results).toHaveLength(N);
    late.disconnect();
  }, 60_000);
});
