import { Logger } from '@nestjs/common';
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
  type WirePlayerAction,
} from '@river/shared-types';
import { ChipsService } from '../chips/chips.service';
import { LobbyService } from '../lobby/lobby.service';
import { PrismaService } from '../infra/prisma/prisma.service';
import { RedisService } from '../infra/redis/redis.service';
import { TokenService } from '../auth/token.service';
import { projectEvent } from '../tables/event-projection';
import { projectTableState } from '../tables/table-projection';
import { TableManager } from '../tables/table-manager';
import type { RunnerNotification, TableRunner } from '../tables/table-runner';
import { createWsAuthMiddleware, socketUser } from './ws-auth';

const ROOM = (tableId: string): string => `table:${tableId}`;

@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class PokerGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(PokerGateway.name);

  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly tokens: TokenService,
    private readonly manager: TableManager,
    private readonly chips: ChipsService,
    private readonly lobby: LobbyService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async afterInit(server: Server): Promise<void> {
    const pub = this.redis.duplicate();
    const sub = this.redis.duplicate();
    await Promise.all([pub.connect().catch(() => undefined), sub.connect().catch(() => undefined)]);
    server.adapter(createAdapter(pub, sub));

    server.use(createWsAuthMiddleware(this.tokens));
    this.manager.subscribe((tableId, notification, runner) => {
      void this.handleNotification(tableId, notification, runner);
    });
    this.logger.log('Poker gateway initialised');
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
    const user = safeUser(socket);
    if (!user) return;
    for (const room of socket.rooms) {
      if (!room.startsWith('table:')) continue;
      const tableId = room.slice('table:'.length);
      if (await this.userHasOtherSocket(tableId, user.userId, socket.id)) continue;
      this.manager.getRunner(tableId)?.setConnected(user.userId, false);
    }
  }

  // --- client -> server ---------------------------------------------------

  @SubscribeMessage(ClientToServer.TABLE_JOIN)
  async onJoin(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ ok: true } | { error: string }> {
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
      await socket.join(ROOM(parsed.data.tableId));
      await this.sendStateTo(socket, runner);
      return { ok: true };
    }

    try {
      await this.chips.debit(user.userId, parsed.data.buyIn);
    } catch {
      return { error: 'insufficient chips for that buy-in' };
    }

    const profile = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: { username: true, avatarUrl: true },
    });

    runner.join({
      userId: user.userId,
      username: profile?.username ?? 'player',
      avatarUrl: profile?.avatarUrl ?? null,
      seatNumber: parsed.data.seatNumber,
      stack: parsed.data.buyIn,
      connected: true,
    });
    runner.setConnected(user.userId, true);
    void this.lobby.leaveWaitlist(user.userId, parsed.data.tableId).catch(() => undefined);
    await socket.join(ROOM(parsed.data.tableId));
    await this.sendStateTo(socket, runner);
    return { ok: true };
  }

  @SubscribeMessage(ClientToServer.TABLE_LEAVE)
  async onLeave(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ ok: true } | { error: string }> {
    const parsed = leaveTableSchema.safeParse(body);
    if (!parsed.success) return { error: 'invalid leave payload' };
    const user = socketUser(socket);
    this.manager.getRunner(parsed.data.tableId)?.leave(user.userId);
    await socket.leave(ROOM(parsed.data.tableId));
    return { ok: true };
  }

  @SubscribeMessage(ClientToServer.PLAYER_ACTION)
  onAction(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): { ok: true } | { error: string } {
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
