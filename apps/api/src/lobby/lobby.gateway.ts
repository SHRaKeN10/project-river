import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { LobbyClientToServer, LobbyServerToClient, lobbyFilterSchema } from '@river/shared-types';
import { TableManager } from '../tables/table-manager';
import { socketUser } from '../realtime/ws-auth';
import { LobbyService } from './lobby.service';
import { WaitlistService } from './waitlist.service';

const LOBBY_ROOM = 'lobby';

/**
 * Pushes live lobby deltas to clients on the lobby screen. Reuses the same
 * socket.io server (and JWT handshake auth) as the poker gateway.
 */
@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class LobbyGateway implements OnGatewayInit {
  private readonly logger = new Logger(LobbyGateway.name);

  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly lobby: LobbyService,
    private readonly tables: TableManager,
    private readonly waitlist: WaitlistService,
  ) {}

  afterInit(server: Server): void {
    this.server = server;
    this.waitlist.bind({
      notify: (userId, tableId, seatNumber, expiresAt) =>
        this.emitToUser(userId, LobbyServerToClient.WAITLIST_SEAT_AVAILABLE, {
          tableId,
          seatNumber,
          expiresAt,
        }),
      isOnline: (userId) => this.isOnline(userId),
    });
    this.tables.subscribe((tableId, notification) => {
      if (
        notification.kind === 'state' ||
        notification.kind === 'handComplete' ||
        notification.kind === 'seatVacated'
      ) {
        void this.pushDelta(tableId);
      }
      if (notification.kind === 'seatVacated') {
        // The seat row is cleared by an in-flight cash-out; wait for it so the
        // promote sees the seat as actually open (the sweeper is the backstop).
        void this.tables
          .settleSeatChanges(tableId)
          .catch(() => undefined)
          .then(() => this.waitlist.seatVacated(tableId));
      }
    });
    this.logger.log('Lobby gateway initialised');
  }

  private isOnline(userId: string): boolean {
    for (const socket of this.server.sockets.sockets.values()) {
      if ((socket.data as { user?: { userId: string } }).user?.userId === userId) return true;
    }
    return false;
  }

  private emitToUser(userId: string, event: string, payload: unknown): void {
    for (const socket of this.server.sockets.sockets.values()) {
      if ((socket.data as { user?: { userId: string } }).user?.userId === userId) {
        socket.emit(event, payload);
      }
    }
  }

  @SubscribeMessage(LobbyClientToServer.LOBBY_SUBSCRIBE)
  async onSubscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ ok: true } | { error: string }> {
    const user = socketUser(socket);
    const parsed = lobbyFilterSchema.safeParse(body ?? {});
    if (!parsed.success) return { error: 'invalid filter' };
    await socket.join(LOBBY_ROOM);
    socket.emit(LobbyServerToClient.LOBBY_TABLES, await this.lobby.list(user.userId, parsed.data));
    return { ok: true };
  }

  @SubscribeMessage(LobbyClientToServer.LOBBY_UNSUBSCRIBE)
  async onUnsubscribe(@ConnectedSocket() socket: Socket): Promise<{ ok: true }> {
    await socket.leave(LOBBY_ROOM);
    return { ok: true };
  }

  private async pushDelta(tableId: string): Promise<void> {
    const delta = await this.lobby.tableDelta(tableId).catch(() => null);
    if (delta) this.server.to(LOBBY_ROOM).emit(LobbyServerToClient.LOBBY_UPDATE, delta);
  }
}
