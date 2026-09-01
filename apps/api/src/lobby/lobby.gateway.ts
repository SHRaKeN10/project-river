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
  ) {}

  afterInit(server: Server): void {
    this.server = server;
    this.tables.subscribe((tableId, notification) => {
      if (
        notification.kind === 'state' ||
        notification.kind === 'handComplete' ||
        notification.kind === 'seatVacated'
      ) {
        void this.pushDelta(tableId);
      }
      if (notification.kind === 'seatVacated') void this.promoteWaitlist(tableId);
    });
    this.logger.log('Lobby gateway initialised');
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

  private async promoteWaitlist(tableId: string): Promise<void> {
    const head = await this.lobby.waitlistHead(tableId).catch(() => null);
    if (!head) return;
    const sockets = await this.server.fetchSockets();
    for (const s of sockets) {
      if ((s.data as { user?: { userId: string } }).user?.userId === head) {
        s.emit(LobbyServerToClient.WAITLIST_SEAT_AVAILABLE, { tableId });
      }
    }
  }
}
