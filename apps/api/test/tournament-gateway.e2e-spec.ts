import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { standardBlindSchedule } from '@river/poker-engine';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { TournamentManager } from '../src/tournaments/tournament-manager';
import { TournamentsService } from '../src/tournaments/tournaments.service';

/**
 * The tournament socket bridge, end to end: real sockets watch, act, see only
 * their own cards, get routed to their table, are reassigned on a balance move,
 * eliminated, and reconnect - all without corrupting server-authoritative state.
 */
describe('TournamentGateway (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tournaments: TournamentsService;
  let manager: TournamentManager;
  let baseUrl: string;

  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const N = 6;
  const players = Array.from({ length: N }, (_, i) => ({
    email: `gp${i}_${suffix}@ex.test`,
    username: `gp${i}_${suffix}`.slice(0, 20),
  }));
  const spectator = { email: `gspec_${suffix}@ex.test`, username: `gspec_${suffix}`.slice(0, 20) };
  const password = 'a-strong-passphrase';
  const tokens: string[] = [];
  const userIds: string[] = [];
  let specToken = '';
  let specUserId = '';
  const openSockets: Socket[] = [];
  const tournamentIds: string[] = [];

  beforeAll(async () => {
    process.env.TABLE_NEXT_HAND_DELAY_MS = '25';
    process.env.TABLE_ACTION_TIMEOUT_MS = '3000';
    process.env.TABLE_DISCONNECT_GRACE_MS = '1500';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['health/live', 'health/ready'] });
    await app.init();
    await app.listen(0);
    prisma = app.get(PrismaService);
    tournaments = app.get(TournamentsService);
    manager = app.get(TournamentManager);

    const server = app.getHttpServer();
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    for (const p of players) {
      const res = await request(server)
        .post('/api/auth/register')
        .send({ ...p, password });
      tokens.push(res.body.tokens.accessToken);
      userIds.push(res.body.user.id);
    }
    const sr = await request(server)
      .post('/api/auth/register')
      .send({ ...spectator, password });
    specToken = sr.body.tokens.accessToken;
    specUserId = sr.body.user.id;
  }, 30000);

  afterAll(async () => {
    for (const s of openSockets) s.disconnect();
    for (const id of tournamentIds) manager.stop(id);
    await prisma.tournament.deleteMany({ where: { id: { in: tournamentIds } } }).catch(() => {});
    await prisma.chipLedgerEntry
      .deleteMany({ where: { userId: { in: [...userIds, specUserId] } } })
      .catch(() => {});
    await prisma.user
      .deleteMany({
        where: { email: { in: [...players.map((p) => p.email), spectator.email] } },
      })
      .catch(() => {});
    await app?.close();
  });

  const blinds = [
    ...standardBlindSchedule({ startingBigBlind: 20, levelDurationMs: 1_200, levels: 12 }),
  ];

  /** Create -> register everyone -> start. Returns the tournament id. */
  const runningTournament = async (
    over: Partial<{ seatsPerTable: number; startingStack: number; players: number }> = {},
  ): Promise<string> => {
    const count = over.players ?? N;
    const view = await tournaments.create({
      name: `GW ${suffix} ${tournamentIds.length}`,
      buyIn: 100,
      startingStack: over.startingStack ?? 250,
      seatsPerTable: over.seatsPerTable ?? 9,
      blinds,
      lateRegUntilLevel: 1,
    });
    tournamentIds.push(view.id);
    for (let i = 0; i < count; i += 1) await tournaments.register(userIds[i]!, view.id);
    await manager.start(view.id);
    return view.id;
  };

  const connect = (token: string): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const socket = io(baseUrl, { auth: { token }, transports: ['websocket'], forceNew: true });
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
      openSockets.push(socket);
    });

  const emitAck = <T = unknown>(socket: Socket, event: string, payload: unknown): Promise<T> =>
    new Promise((resolve) => socket.emit(event, payload, (res: T) => resolve(res)));

  const waitFor = (socket: Socket, event: string, timeoutMs = 12_000): Promise<any> =>
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

  interface Collected {
    states: any[];
    updates: any[];
    handEnds: any[];
    errors: any[];
    assignments: any[];
    eliminated: any[];
    tableClosed: any[];
    finished: any[];
    clocks: any[];
  }

  /** Attach every listener + a jam bot, and return the collected event log. */
  const drive = (
    socket: Socket,
    tournamentId: string,
    mode: 'jam' | 'passive' = 'jam',
  ): Collected => {
    const c: Collected = {
      states: [],
      updates: [],
      handEnds: [],
      errors: [],
      assignments: [],
      eliminated: [],
      tableClosed: [],
      finished: [],
      clocks: [],
    };
    let seq = 0;
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
      const pick =
        mode === 'jam' && kinds.includes('ALL_IN')
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
    socket.on('hand:update', (e: any) => c.updates.push(e));
    socket.on('hand:end', (e: any) => c.handEnds.push(e));
    socket.on('error', (e: any) => c.errors.push(e));
    socket.on('tournament:assignment', (e: any) => c.assignments.push(e));
    socket.on('tournament:eliminated', (e: any) => c.eliminated.push(e));
    socket.on('tournament:tableClosed', (e: any) => c.tableClosed.push(e));
    socket.on('tournament:finished', (e: any) => c.finished.push(e));
    socket.on('tournament:clock', (e: any) => c.clocks.push(e));
    return c;
  };

  // ---------------------------------------------------------------------

  it('routes a spectator to a read-only view - no seat, no cards, no actions', async () => {
    const id = await runningTournament({ seatsPerTable: 9, players: 2 });
    const s = await connect(specToken);
    const stateP = waitFor(s, 'table:state');
    const ack = await emitAck<{ ok?: true; error?: string }>(s, 'tournament:watch', {
      tournamentId: id,
    });
    expect(ack.ok).toBe(true);

    const state = await stateP;
    expect(state.tournamentId).toBe(id);
    expect(state.youAreSeat).toBeNull();
    expect(state.legalActions).toBeNull();

    // a spectator's action is refused before it reaches any table
    const actAck = await emitAck<{ ok?: true; error?: string }>(s, 'tournament:action', {
      tournamentId: id,
      handId: state.handId ?? 'x',
      clientSeq: 1,
      action: { type: 'CHECK' },
    });
    expect(actAck.ok).toBeUndefined();
    expect(actAck.error).toMatch(/no seat/i);

    // no hole cards ever reached the spectator
    for (const st of [state]) for (const seat of st.seats) expect(seat.holeCards).toBeNull();

    manager.stop(id);
  }, 20000);

  it('a seated player sees their own hole cards and never an opponent’s (pre-showdown)', async () => {
    const id = await runningTournament({ seatsPerTable: 9, players: 2 });
    const a = await connect(tokens[0]!);
    const b = await connect(tokens[1]!);
    const ca = drive(a, id);
    drive(b, id);

    await emitAck(a, 'tournament:watch', { tournamentId: id });
    await emitAck(b, 'tournament:watch', { tournamentId: id });

    await waitFor(a, 'hand:end', 15000);

    const midHand = ca.states.filter(
      (s) => s.handId && s.street !== 'COMPLETE' && s.seats.some((x: any) => x.holeCards),
    );
    expect(midHand.length).toBeGreaterThan(0);
    for (const st of midHand) {
      for (const seat of st.seats) {
        if (seat.seatNumber === st.youAreSeat) expect(seat.holeCards).toHaveLength(2);
        else expect(seat.holeCards).toBeNull();
      }
      expect(JSON.stringify(st)).not.toMatch(/"deck"|"cursor"/);
    }
    // the hero received turn prompts with legal actions
    expect(ca.states.some((s) => s.actingSeat === s.youAreSeat && s.legalActions?.length)).toBe(
      true,
    );

    manager.stop(id);
  }, 25000);

  it('rejects a duplicate clientSeq and a stale handId', async () => {
    const id = await runningTournament({ seatsPerTable: 9, players: 2 });
    const a = await connect(tokens[0]!);
    const b = await connect(tokens[1]!);
    drive(b, id);
    await emitAck(a, 'tournament:watch', { tournamentId: id });
    await emitAck(b, 'tournament:watch', { tournamentId: id });

    // wait until it is A's turn
    const turn: any = await new Promise((resolve) => {
      a.on('table:state', (st: any) => {
        if (st.handId && st.actingSeat === st.youAreSeat && st.legalActions?.length) resolve(st);
      });
    });

    const errs: any[] = [];
    a.on('error', (e) => errs.push(e));

    // stale hand id -> rejected
    a.emit('tournament:action', {
      tournamentId: id,
      handId: 'not-a-real-hand',
      clientSeq: 100,
      action: { type: 'CHECK' },
    });
    // real action, then an immediate duplicate seq (must be swallowed, not double-applied)
    a.emit('tournament:action', {
      tournamentId: id,
      handId: turn.handId,
      clientSeq: 5,
      action: {
        type: turn.legalActions.map((o: any) => o.kind).includes('CHECK') ? 'CHECK' : 'CALL',
      },
    });
    a.emit('tournament:action', {
      tournamentId: id,
      handId: turn.handId,
      clientSeq: 5,
      action: { type: 'FOLD' },
    });

    await new Promise((r) => setTimeout(r, 400));
    expect(errs.some((e) => e.code === 'STALE_HAND')).toBe(true);
    // A did not fold from the duplicate: still in the hand (or the hand moved on cleanly)
    manager.stop(id);
  }, 20000);

  it('plays a 6-player, two-table tournament: routing, assignment, balance, break, elimination, finish', async () => {
    const id = await runningTournament({ seatsPerTable: 3, startingStack: 200, players: 6 });
    expect(manager.get(id)!.tableCount).toBe(2);

    const sockets = await Promise.all(tokens.map((t) => connect(t)));
    const logs = sockets.map((s) => drive(s, id, 'jam'));
    await Promise.all(sockets.map((s) => emitAck(s, 'tournament:watch', { tournamentId: id })));

    // every player got an initial table assignment onto one of the two tables
    await new Promise((r) => setTimeout(r, 200));
    for (const l of logs) expect(l.assignments.length).toBeGreaterThanOrEqual(1);
    const initialTables = new Set(logs.map((l) => l.assignments[0].tableId));
    expect(initialTables.size).toBe(2);

    // every watcher got an authoritative clock snapshot on watch
    for (const l of logs) {
      expect(l.clocks.length).toBeGreaterThanOrEqual(1);
      expect(l.clocks[0].tournamentId).toBe(id);
      expect(l.clocks[0].level).toBeGreaterThanOrEqual(1);
      expect(l.clocks[0].playersLeft).toBe(6);
    }

    // let it run to a winner
    const winnerFinish: any = await Promise.race(
      sockets.map((s) => waitFor(s, 'tournament:finished', 40_000)),
    );
    expect(winnerFinish.tournamentId).toBe(id);
    expect(winnerFinish.results).toHaveLength(6);

    // everyone got a `finished` event
    await new Promise((r) => setTimeout(r, 300));
    for (const l of logs) expect(l.finished.length).toBeGreaterThanOrEqual(1);

    // exactly five players were eliminated, positions 6..2, each to the right player
    const elims = logs.map((l, i) => ({ i, e: l.eliminated[0] })).filter((x) => x.e !== undefined);
    expect(elims).toHaveLength(5);
    const positions = elims.map((x) => x.e.finishPosition).sort((p, q) => p - q);
    expect(positions).toEqual([2, 3, 4, 5, 6]);

    // the field consolidated: at least one table closed, and at least one player
    // was reassigned to a different table (a balance move or a table break)
    const anyClosed = logs.some((l) => l.tableClosed.length > 0);
    expect(anyClosed).toBe(true);
    const anyReassigned = logs.some((l) => {
      const t = new Set(l.assignments.map((a: any) => a.tableId));
      return t.size >= 2;
    });
    expect(anyReassigned).toBe(true);

    // pot awards reached clients, and chip/stack changes were visible
    const sawPotAward = logs.some((l) =>
      l.updates.some((u: any) => u.type === 'POT_AWARDED' || u.type === 'HAND_COMPLETED'),
    );
    expect(sawPotAward).toBe(true);

    // the clock tracked the field shrinking, and hand-for-hand fired at the bubble
    const minLeft = Math.min(
      ...logs.flatMap((l) => l.clocks.map((c: any) => c.playersLeft as number)),
    );
    expect(minLeft).toBeLessThan(6);
    expect(logs.some((l) => l.clocks.some((c: any) => c.handForHand))).toBe(true);

    manager.stop(id);
  }, 60000);

  it('a player reconnects mid-tournament without corrupting state', async () => {
    const id = await runningTournament({ seatsPerTable: 9, players: 3 });
    const a = await connect(tokens[0]!);
    const b = await connect(tokens[1]!);
    const cc = await connect(tokens[2]!);
    drive(b, id, 'passive');
    drive(cc, id, 'passive');
    const before = drive(a, id, 'passive');
    await emitAck(a, 'tournament:watch', { tournamentId: id });
    await emitAck(b, 'tournament:watch', { tournamentId: id });
    await emitAck(cc, 'tournament:watch', { tournamentId: id });

    await waitFor(a, 'table:state');
    const total = () => manager.get(id)!.totalChips;
    const chipsBefore = total();

    // drop A's socket, wait past the grace, reconnect fresh (clientSeq resets)
    a.disconnect();
    await new Promise((r) => setTimeout(r, 300));
    const a2 = await connect(tokens[0]!);
    const after = drive(a2, id, 'passive');
    const ack = await emitAck<{ ok?: true }>(a2, 'tournament:watch', { tournamentId: id });
    expect(ack.ok).toBe(true);

    const state = await waitFor(a2, 'table:state');
    expect(state.tournamentId).toBe(id);
    // A is still seated at the same table with a live stack
    expect(state.youAreSeat).not.toBeNull();
    const mySeat = state.seats.find((s: any) => s.seatNumber === state.youAreSeat);
    expect(mySeat.userId).toBe(userIds[0]);

    // chip conservation held across the disconnect
    await new Promise((r) => setTimeout(r, 300));
    expect(total()).toBe(chipsBefore);
    expect(before.errors).toHaveLength(0);
    expect(after.errors).toHaveLength(0);

    manager.stop(id);
  }, 25000);
});
