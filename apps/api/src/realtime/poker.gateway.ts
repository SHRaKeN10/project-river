import { randomUUID } from 'node:crypto';
import { Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server, Socket } from 'socket.io';
import { allIn, betTo, call, check, fold, type PlayerAction, raiseTo } from '@river/poker-engine';
import {
  ClientToServer,
  joinTableSchema,
  leaveTableSchema,
  ServerToClient,
  tableActionSchema,
  tableChatSchema,
  tableRoomSchema,
  type WirePlayerAction,
} from '@river/shared-types';
import { LobbyService } from '../lobby/lobby.service';
import { PrismaService } from '../infra/prisma/prisma.service';
import { RedisService } from '../infra/redis/redis.service';
import { SessionBlocklistService } from '../auth/session-blocklist.service';
import { TokenService } from '../auth/token.service';
import { projectEvent } from '../tables/event-projection';
import { projectTableState } from '../tables/table-projection';
import { TableManager } from '../tables/table-manager';
import { TablesService } from '../tables/tables.service';
import type { RunnerNotification, TableRunner } from '../tables/table-runner';
import { SocketRateLimiter, type RateClass } from './socket-rate-limiter';
import { createWsAuthMiddleware, socketUser } from './ws-auth';

const ROOM = (tableId: string): string => `table:${tableId}`;

/** How often to drop sockets whose session has been revoked since they
 * connected (logout, password reset, ban, refresh-token reuse). */
const SESSION_SWEEP_MS = 60_000;

@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class PokerGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(PokerGateway.name);
  private sessionSweep: ReturnType<typeof setInterval> | null = null;
  private readonly rate = new SocketRateLimiter();
  /** table rooms each socket has entered - `socket.rooms` is already cleared by
   * the time `handleDisconnect` runs, so we track membership ourselves. */
  private readonly socketTables = new Map<string, Set<string>>();

  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly tokens: TokenService,
    private readonly blocklist: SessionBlocklistService,
    private readonly manager: TableManager,
    private readonly tables: TablesService,
    private readonly lobby: LobbyService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async afterInit(server: Server): Promise<void> {
    const pub = this.redis.duplicate();
    const sub = this.redis.duplicate();
    await Promise.all([pub.connect().catch(() => undefined), sub.connect().catch(() => undefined)]);
    server.adapter(createAdapter(pub, sub));

    server.use(createWsAuthMiddleware(this.tokens, this.blocklist));
    this.manager.subscribe((tableId, notification, runner) => {
      void this.handleNotification(tableId, notification, runner);
    });

    // The handshake auth check is one-time. Re-check periodically so a session
    // that gets revoked while a socket stays connected is actually cut off.
    this.sessionSweep = setInterval(() => void this.dropRevokedSockets(), SESSION_SWEEP_MS);
    this.sessionSweep.unref?.();

    this.logger.log('Poker gateway initialised');
  }

  onModuleDestroy(): void {
    if (this.sessionSweep) clearInterval(this.sessionSweep);
  }

  /** Sockets connected to this node (for the ops /metrics endpoint). */
  connectedSocketCount(): number {
    return this.server?.sockets?.sockets?.size ?? 0;
  }

  private async dropRevokedSockets(): Promise<void> {
    let sockets;
    try {
      sockets = await this.server.fetchSockets();
    } catch {
      return;
    }
    for (const s of sockets) {
      const user = (s.data as { user?: { sessionId: string; userId: string } }).user;
      if (!user) {
        s.disconnect(true);
        continue;
      }
      if (await this.blocklist.isRevoked(user.sessionId)) {
        this.logger.debug(`dropping socket ${s.id}: session ${user.sessionId} revoked`);
        s.disconnect(true);
      }
    }
  }

  handleConnection(socket: Socket): void {
    try {
      const user = socketUser(socket);
      this.logger.debug(`socket ${socket.id} connected (user ${user.userId})`);
    } catch {
      socket.disconnect(true);
    }
  }

  async handleDisconnect(socket: Socket): Promise<void> {
    this.rate.forget(socket.id);
    const tableIds = this.socketTables.get(socket.id);
    this.socketTables.delete(socket.id);
    const user = safeUser(socket);
    if (!user || !tableIds) return;
    for (const tableId of tableIds) {
      if (await this.userHasOtherSocket(tableId, user.userId, socket.id)) continue;
      this.manager.getRunner(tableId)?.setConnected(user.userId, false);
    }
  }

  /** Remember (for handleDisconnect) that this socket is in a table room. */
  private trackRoom(socket: Socket, tableId: string): void {
    let set = this.socketTables.get(socket.id);
    if (!set) {
      set = new Set();
      this.socketTables.set(socket.id, set);
    }
    set.add(tableId);
  }

  private untrackRoom(socket: Socket, tableId: string): void {
    this.socketTables.get(socket.id)?.delete(tableId);
  }

  // --- client -> server ---------------------------------------------------

  @SubscribeMessage(ClientToServer.TABLE_JOIN)
  async onJoin(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ ok: true } | { error: string }> {
    if (this.tooFast(socket, 'room')) return { error: 'you are doing that too fast' };
    const parsed = joinTableSchema.safeParse(body);
    if (!parsed.success) return { error: 'invalid join payload' };
    const user = socketUser(socket);

    let runner: TableRunner;
    try {
      runner = await this.manager.getOrCreate(parsed.data.tableId);
    } catch {
      return { error: 'table not found' };
    }
    if (runner.seatOf(user.userId) !== null) {
      // Already seated - this is a reconnect. Mark them present again so the
      // away sweep doesn't stand them up, and refresh their view.
      runner.setConnected(user.userId, true);
      this.trackRoom(socket, parsed.data.tableId);
      await socket.join(ROOM(parsed.data.tableId));
      await this.sendStateTo(socket, runner);
      return { ok: true };
    }

    const { minBuyIn, maxBuyIn } = runner.meta;
    if (parsed.data.buyIn < minBuyIn || parsed.data.buyIn > maxBuyIn) {
      return { error: `buy-in must be ${minBuyIn}-${maxBuyIn}` };
    }

    // A player who just left may still have a cash-out (and its DB seat-clear)
    // in flight - wait for it so this join's "already seated" guard is accurate.
    await this.manager.settleSeatChanges(parsed.data.tableId);

    // Debit + claim the seat in one DB transaction: a crash can never leave
    // chips gone without a seat (or vice versa).
    const seated = await this.tables.sitDown({
      tableId: parsed.data.tableId,
      seatNumber: parsed.data.seatNumber,
      userId: user.userId,
      buyIn: parsed.data.buyIn,
      idemKey: `buyin:${randomUUID()}`,
    });
    if (!seated.ok) return { error: seated.error };

    const profile = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: { username: true, avatarUrl: true },
    });

    // The DB seat is claimed; mirror it into the runner's in-memory roster. This
    // should never fail (the DB is the authority now); if it somehow does, undo
    // the transaction so chips aren't stranded.
    const outcome = runner.join({
      userId: user.userId,
      username: profile?.username ?? 'player',
      avatarUrl: profile?.avatarUrl ?? null,
      seatNumber: parsed.data.seatNumber,
      stack: parsed.data.buyIn,
      connected: true,
    });
    if (!outcome.ok) {
      this.logger.error(
        `seat ${parsed.data.seatNumber}@${parsed.data.tableId} claimed in DB but runner refused (${outcome.code}); refunding`,
      );
      await this.tables
        .standUp({
          tableId: parsed.data.tableId,
          seatNumber: parsed.data.seatNumber,
          userId: user.userId,
          finalStack: parsed.data.buyIn,
          idemKey: `buyin-undo:${randomUUID()}`,
        })
        .catch(() => undefined);
      return { error: outcome.reason };
    }

    runner.setConnected(user.userId, true);
    this.trackRoom(socket, parsed.data.tableId);
    void this.lobby.leaveWaitlist(user.userId, parsed.data.tableId).catch(() => undefined);
    await socket.join(ROOM(parsed.data.tableId));
    await this.sendStateTo(socket, runner);
    return { ok: true };
  }

  @SubscribeMessage(ClientToServer.TABLE_WATCH)
  async onWatch(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ ok: true } | { error: string }> {
    if (this.tooFast(socket, 'room')) return { error: 'you are doing that too fast' };
    const parsed = tableRoomSchema.safeParse(body);
    if (!parsed.success) return { error: 'invalid watch payload' };
    let runner: TableRunner;
    try {
      runner = await this.manager.getOrCreate(parsed.data.tableId);
    } catch {
      return { error: 'table not found' };
    }
    const user = safeUser(socket);
    // The client re-issues `watch` on every reconnect - if the watcher is
    // actually seated here, that's them coming back.
    if (user && runner.seatOf(user.userId) !== null) {
      runner.setConnected(user.userId, true);
    }
    this.trackRoom(socket, parsed.data.tableId);
    await socket.join(ROOM(parsed.data.tableId));
    await this.sendStateTo(socket, runner);
    return { ok: true };
  }

  @SubscribeMessage(ClientToServer.TABLE_UNWATCH)
  async onUnwatch(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ ok: true } | { error: string }> {
    if (this.tooFast(socket, 'room')) return { error: 'you are doing that too fast' };
    const parsed = tableRoomSchema.safeParse(body);
    if (!parsed.success) return { error: 'invalid unwatch payload' };
    const user = socketUser(socket);
    // Only leave the room if the caller isn't actually seated here.
    if (this.manager.getRunner(parsed.data.tableId)?.seatOf(user.userId) == null) {
      this.untrackRoom(socket, parsed.data.tableId);
      await socket.leave(ROOM(parsed.data.tableId));
    }
    return { ok: true };
  }

  @SubscribeMessage(ClientToServer.TABLE_LEAVE)
  async onLeave(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ ok: true } | { error: string }> {
    if (this.tooFast(socket, 'room')) return { error: 'you are doing that too fast' };
    const parsed = leaveTableSchema.safeParse(body);
    if (!parsed.success) return { error: 'invalid leave payload' };
    const user = socketUser(socket);
    this.manager.getRunner(parsed.data.tableId)?.leave(user.userId);
    this.untrackRoom(socket, parsed.data.tableId);
    await socket.leave(ROOM(parsed.data.tableId));
    // Ack only once the stack is actually back in the wallet, so a client that
    // immediately re-joins (or checks its balance) sees a settled state.
    await this.manager.settleSeatChanges(parsed.data.tableId);
    return { ok: true };
  }

  @SubscribeMessage(ClientToServer.PLAYER_ACTION)
  onAction(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): { ok: true } | { error: string } {
    if (this.tooFast(socket, 'action')) return { error: 'you are acting too fast' };
    const parsed = tableActionSchema.safeParse(body);
    if (!parsed.success) return { error: 'invalid action payload' };
    const user = socketUser(socket);
    const runner = this.manager.getRunner(parsed.data.tableId);
    if (!runner) return { error: 'table not active' };

    let action: PlayerAction;
    try {
      action = toEngineAction(parsed.data.action);
    } catch (err) {
      return { error: (err as Error).message };
    }
    runner.submitAction(user.userId, parsed.data.handId, parsed.data.clientSeq, action);
    return { ok: true };
  }

  @SubscribeMessage(ClientToServer.PLAYER_SIT_OUT)
  onSitOut(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): { ok: true } | { error: string } {
    return this.toggleSit(socket, body, true);
  }

  @SubscribeMessage(ClientToServer.PLAYER_RETURN)
  onReturn(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): { ok: true } | { error: string } {
    return this.toggleSit(socket, body, false);
  }

  @SubscribeMessage(ClientToServer.PLAYER_READY)
  onReady(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): { ok: true } | { error: string } {
    return this.toggleSit(socket, body, false);
  }

  @SubscribeMessage(ClientToServer.TABLE_CHAT)
  onChat(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): { ok: true } | { error: string } {
    if (this.tooFast(socket, 'chat')) return { error: 'you are sending messages too fast' };
    const parsed = tableChatSchema.safeParse(body);
    if (!parsed.success) return { error: 'invalid chat payload' };
    const user = socketUser(socket);
    const runner = this.manager.getRunner(parsed.data.tableId);
    if (!runner || runner.seatOf(user.userId) === null) return { error: 'not seated' };
    void this.prisma.user
      .findUnique({ where: { id: user.userId }, select: { username: true } })
      .then((p) => runner.chat(user.userId, p?.username ?? 'player', parsed.data.text));
    return { ok: true };
  }

  private toggleSit(
    socket: Socket,
    body: unknown,
    sittingOut: boolean,
  ): { ok: true } | { error: string } {
    if (this.tooFast(socket, 'misc')) return { error: 'you are doing that too fast' };
    const parsed = leaveTableSchema.safeParse(body);
    if (!parsed.success) return { error: 'invalid payload' };
    const user = socketUser(socket);
    this.manager.getRunner(parsed.data.tableId)?.setSittingOut(user.userId, sittingOut);
    return { ok: true };
  }

  // --- server -> client -------------------------------------------------

  private async handleNotification(
    tableId: string,
    notification: RunnerNotification,
    runner: TableRunner,
  ): Promise<void> {
    const sockets = await this.server.in(ROOM(tableId)).fetchSockets();

    switch (notification.kind) {
      case 'state': {
        for (const s of sockets) {
          const user = (s.data as { user?: { userId: string } }).user;
          s.emit(ServerToClient.TABLE_STATE, this.viewFor(runner, user?.userId ?? null));
        }
        return;
      }
      case 'events': {
        for (const s of sockets) {
          const user = (s.data as { user?: { userId: string } }).user;
          const seat = user ? runner.seatOf(user.userId) : null;
          for (const event of notification.events) {
            const wire = projectEvent(event, seat);
            if (!wire) continue;
            s.emit(ServerToClient.HAND_UPDATE, wire);
            if (event.type === 'HAND_STARTED') s.emit(ServerToClient.HAND_START, wire);
            if (event.type === 'HAND_COMPLETED') s.emit(ServerToClient.HAND_END, wire);
          }
        }
        return;
      }
      case 'rejected': {
        for (const s of sockets) {
          const user = (s.data as { user?: { userId: string } }).user;
          if (user?.userId === notification.userId) {
            s.emit(ServerToClient.ERROR, {
              code: notification.code,
              message: notification.reason,
            });
          }
        }
        return;
      }
      case 'chat': {
        this.server.to(ROOM(tableId)).emit(ClientToServer.TABLE_CHAT, notification.message);
        return;
      }
      case 'handComplete':
        return;
    }
  }

  /** True (and logs) when the socket is over its budget for this message class. */
  private tooFast(socket: Socket, klass: RateClass): boolean {
    if (this.rate.allow(socket.id, klass)) return false;
    this.logger.debug(`rate-limited socket ${socket.id} (${klass})`);
    return true;
  }

  private viewFor(runner: TableRunner, viewerUserId: string | null) {
    return projectTableState({
      table: runner.meta,
      state: runner.gameState,
      roster: runner.rosterEntries,
      revealedSeats: runner.revealed,
      viewerUserId,
    });
  }

  private async sendStateTo(socket: Socket, runner: TableRunner): Promise<void> {
    const user = safeUser(socket);
    socket.emit(ServerToClient.TABLE_STATE, this.viewFor(runner, user?.userId ?? null));
  }

  private async userHasOtherSocket(
    tableId: string,
    userId: string,
    exceptSocketId: string,
  ): Promise<boolean> {
    const sockets = await this.server.in(ROOM(tableId)).fetchSockets();
    return sockets.some(
      (s) =>
        s.id !== exceptSocketId &&
        (s.data as { user?: { userId: string } }).user?.userId === userId,
    );
  }
}

function toEngineAction(action: WirePlayerAction): PlayerAction {
  switch (action.type) {
    case 'FOLD':
      return fold();
    case 'CHECK':
      return check();
    case 'CALL':
      return call();
    case 'ALL_IN':
      return allIn();
    case 'BET':
      if (action.amount === undefined) throw new Error('bet requires an amount');
      return betTo(action.amount);
    case 'RAISE':
      if (action.amount === undefined) throw new Error('raise requires an amount');
      return raiseTo(action.amount);
    default:
      throw new Error('unknown action');
  }
}

function safeUser(socket: Socket): { userId: string } | null {
  return (socket.data as { user?: { userId: string } }).user ?? null;
}
