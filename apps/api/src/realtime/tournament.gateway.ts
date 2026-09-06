import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { type GameEvent, type GameState } from '@river/poker-engine';
import {
  ClientToServer,
  ServerToClient,
  type TableStateView,
  tournamentActionSchema,
  tournamentWatchSchema,
} from '@river/shared-types';
import { projectEvent } from '../tables/event-projection';
import { projectTableState } from '../tables/table-projection';
import type { TournamentPublicEvent } from '../tournaments/tournament-runner';
import { TournamentManager } from '../tournaments/tournament-manager';
import type { TournamentRunner } from '../tournaments/tournament-runner';
import { SocketRateLimiter } from './socket-rate-limiter';
import { toEngineAction } from './wire-action';
import { socketUser } from './ws-auth';

const ROOM = (tournamentId: string, tableId: string): string => `t:${tournamentId}:${tableId}`;

interface Tracked {
  tournamentId: string;
  tableId: string;
  userId: string;
}

/**
 * The socket bridge for tournaments. It reuses everything the cash game already
 * has: the shared socket.io server + JWT handshake (installed by `PokerGateway`),
 * the same `table:state` / `hand:update` wire events, and the same per-viewer
 * `projectTableState` / `projectEvent` code - so the mobile table UI renders a
 * tournament table with no change to its rendering.
 *
 * What's tournament-specific: the client says "I'm watching tournament X" and
 * the server routes it to the player's own table (or the feature table, for a
 * spectator), re-routing it on a balance move; and there is no join / leave /
 * buy-in - the coordinator owns the seats.
 */
@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class TournamentGateway implements OnGatewayInit, OnGatewayDisconnect {
  private readonly logger = new Logger(TournamentGateway.name);
  private readonly rate = new SocketRateLimiter();
  /** socketId -> which tournament table room it currently sits in. */
  private readonly tracked = new Map<string, Tracked>();

  @WebSocketServer()
  private server!: Server;

  constructor(private readonly tournaments: TournamentManager) {}

  afterInit(server: Server): void {
    this.server = server;
    this.tournaments.subscribe((tournamentId, ev) => {
      void this.onEvent(tournamentId, ev);
    });
    this.logger.log('Tournament gateway initialised');
  }

  handleDisconnect(socket: Socket): void {
    this.rate.forget(socket.id);
    const t = this.tracked.get(socket.id);
    this.tracked.delete(socket.id);
    if (!t) return;
    // Only mark them away if this was their last socket for the tournament.
    if (!this.userHasAnotherSocket(t.tournamentId, t.userId, socket.id)) {
      this.tournaments.get(t.tournamentId)?.setConnected(t.userId, false);
    }
  }

  // --- client -> server -------------------------------------------------

  @SubscribeMessage(ClientToServer.TOURNAMENT_WATCH)
  async onWatch(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ ok: true } | { error: string }> {
    if (!this.rate.allow(socket.id, 'room')) return { error: 'you are doing that too fast' };
    const parsed = tournamentWatchSchema.safeParse(body);
    if (!parsed.success) return { error: 'invalid watch payload' };
    const user = socketUser(socket);

    // Wait out an in-flight restart recovery so a client reconnecting during
    // the boot scan gets the recovered runner, not a spurious "not running".
    const runner = await this.tournaments.ensureRunner(parsed.data.tournamentId);
    if (!runner) {
      // The tournament may have just finished (incl. finishing during recovery)
      // while this client was reconnecting - tell them the outcome.
      const results = await this.tournaments.finishedResults(parsed.data.tournamentId);
      if (results) {
        socket.emit(ServerToClient.TOURNAMENT_FINISHED, {
          tournamentId: parsed.data.tournamentId,
          results,
        });
        return { ok: true };
      }
      return { error: 'that tournament is not running' };
    }

    // A busted player reconnecting (e.g. after a restart) is told their finish
    // and routed to a read-only spectator view.
    const standing = runner.entrantView(user.userId);
    if (standing && standing.finishPosition !== null) {
      socket.emit(ServerToClient.TOURNAMENT_ELIMINATED, {
        tournamentId: parsed.data.tournamentId,
        finishPosition: standing.finishPosition,
      });
    }

    const seatedTable = runner.tableIdOf(user.userId);
    const tableId = seatedTable ?? runner.spectatorTableId();
    if (!tableId) return { error: 'the tournament has no active tables' };

    if (seatedTable) runner.setConnected(user.userId, true);
    await this.enterRoom(socket, parsed.data.tournamentId, tableId, user.userId);

    const view = this.viewFor(runner, parsed.data.tournamentId, tableId, user.userId);
    if (view) socket.emit(ServerToClient.TABLE_STATE, view);
    if (runner.running) socket.emit(ServerToClient.TOURNAMENT_CLOCK, runner.clockSnapshot());
    if (seatedTable !== null) {
      const seat = runner.entrantView(user.userId)?.seat ?? null;
      if (seat !== null) {
        socket.emit(ServerToClient.TOURNAMENT_ASSIGNMENT, {
          tournamentId: parsed.data.tournamentId,
          tableId,
          seat,
        });
      }
    }
    return { ok: true };
  }

  @SubscribeMessage(ClientToServer.TOURNAMENT_UNWATCH)
  async onUnwatch(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ ok: true } | { error: string }> {
    const parsed = tournamentWatchSchema.safeParse(body);
    if (!parsed.success) return { error: 'invalid payload' };
    const t = this.tracked.get(socket.id);
    if (t && t.tournamentId === parsed.data.tournamentId) {
      await socket.leave(ROOM(t.tournamentId, t.tableId));
      this.tracked.delete(socket.id);
      // A player who stops watching keeps their seat; they're just marked away
      // (blinded off) until they come back. `handleDisconnect` covers the
      // socket-drop case; this covers "navigated away".
      if (!this.userHasAnotherSocket(t.tournamentId, t.userId, socket.id)) {
        this.tournaments.get(t.tournamentId)?.setConnected(t.userId, false);
      }
    }
    return { ok: true };
  }

  @SubscribeMessage(ClientToServer.TOURNAMENT_ACTION)
  onAction(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): { ok: true } | { error: string } {
    if (!this.rate.allow(socket.id, 'action')) return { error: 'you are acting too fast' };
    const parsed = tournamentActionSchema.safeParse(body);
    if (!parsed.success) return { error: 'invalid action payload' };
    const user = socketUser(socket);

    const runner = this.tournaments.get(parsed.data.tournamentId);
    if (!runner) return { error: 'that tournament is not running' };
    if (runner.tableIdOf(user.userId) === null) {
      return { error: 'you hold no seat in this tournament' };
    }

    let action;
    try {
      action = toEngineAction(parsed.data.action);
    } catch (err) {
      return { error: (err as Error).message };
    }
    // The coordinator routes this to the player's own table; the table rejects
    // it (-> `error` event to this socket) if it isn't their turn or the hand
    // has moved on. A spectator was already stopped above.
    runner.act(user.userId, parsed.data.handId, parsed.data.clientSeq, action);
    return { ok: true };
  }

  // --- server -> client -----------------------------------------------

  private async onEvent(tournamentId: string, ev: TournamentPublicEvent): Promise<void> {
    switch (ev.kind) {
      case 'tableUpdate':
        return this.onTableUpdate(tournamentId, ev.tableId, ev.notification);
      case 'clock':
        for (const [socketId, t] of this.tracked) {
          if (t.tournamentId !== tournamentId) continue;
          this.server.sockets.sockets
            .get(socketId)
            ?.emit(ServerToClient.TOURNAMENT_CLOCK, ev.snapshot);
        }
        return;
      case 'assigned':
        return this.onAssigned(tournamentId, ev.userId, ev.tableId, ev.seat);
      case 'eliminated':
        this.toUser(tournamentId, ev.userId, ServerToClient.TOURNAMENT_ELIMINATED, {
          tournamentId,
          finishPosition: ev.finishPosition,
        });
        return;
      case 'tableClosed':
        this.server
          .to(ROOM(tournamentId, ev.tableId))
          .emit(ServerToClient.TOURNAMENT_TABLE_CLOSED, { tournamentId, tableId: ev.tableId });
        return this.rerouteStrandedSockets(tournamentId, ev.tableId);
      case 'finished':
        for (const [socketId, t] of this.tracked) {
          if (t.tournamentId !== tournamentId) continue;
          this.server.sockets.sockets
            .get(socketId)
            ?.emit(ServerToClient.TOURNAMENT_FINISHED, { tournamentId, results: ev.results });
        }
        return;
    }
  }

  private async onTableUpdate(
    tournamentId: string,
    tableId: string,
    n: Extract<TournamentPublicEvent, { kind: 'tableUpdate' }>['notification'],
  ): Promise<void> {
    const runner = this.tournaments.get(tournamentId);
    if (!runner) return;
    const sockets = await this.server.in(ROOM(tournamentId, tableId)).fetchSockets();

    if (n.kind === 'rejected') {
      for (const s of sockets) {
        if (this.userOf(s) === n.userId) {
          s.emit(ServerToClient.ERROR, { code: n.code, message: n.reason });
        }
      }
      return;
    }

    if (n.kind === 'state') {
      for (const s of sockets) {
        const view = this.viewFor(runner, tournamentId, tableId, this.userOf(s));
        if (view) s.emit(ServerToClient.TABLE_STATE, view);
      }
      return;
    }

    // events
    for (const s of sockets) {
      const seat = this.seatOf(runner, tableId, this.userOf(s));
      for (const event of n.events) {
        const wire = projectEvent(event as GameEvent, seat);
        if (!wire) continue;
        s.emit(ServerToClient.HAND_UPDATE, wire);
        if (event.type === 'HAND_STARTED') s.emit(ServerToClient.HAND_START, wire);
        if (event.type === 'HAND_COMPLETED') s.emit(ServerToClient.HAND_END, wire);
      }
    }
  }

  private async onAssigned(
    tournamentId: string,
    userId: string,
    tableId: string,
    seat: number,
  ): Promise<void> {
    const runner = this.tournaments.get(tournamentId);
    if (!runner) return;

    for (const [socketId, t] of this.tracked) {
      if (t.tournamentId !== tournamentId || t.userId !== userId) continue;
      const socket = this.server.sockets.sockets.get(socketId);
      if (!socket) continue;
      if (t.tableId !== tableId) {
        await socket.leave(ROOM(tournamentId, t.tableId));
        await this.enterRoom(socket, tournamentId, tableId, userId);
      }
      socket.emit(ServerToClient.TOURNAMENT_ASSIGNMENT, { tournamentId, tableId, seat });
      const view = this.viewFor(runner, tournamentId, tableId, userId);
      if (view) socket.emit(ServerToClient.TABLE_STATE, view);
    }
  }

  /** A table dissolved. Seated players were already `assigned` elsewhere; move
   * anyone still tracked to that room (spectators) onto a live table. */
  private async rerouteStrandedSockets(tournamentId: string, closedTableId: string): Promise<void> {
    const runner = this.tournaments.get(tournamentId);
    if (!runner) return;
    for (const [socketId, t] of [...this.tracked]) {
      if (t.tournamentId !== tournamentId || t.tableId !== closedTableId) continue;
      const socket = this.server.sockets.sockets.get(socketId);
      if (!socket) continue;
      await socket.leave(ROOM(tournamentId, closedTableId));
      const dest = runner.tableIdOf(t.userId) ?? runner.spectatorTableId();
      if (!dest) {
        this.tracked.delete(socketId);
        continue;
      }
      await this.enterRoom(socket, tournamentId, dest, t.userId);
      const view = this.viewFor(runner, tournamentId, dest, t.userId);
      if (view) socket.emit(ServerToClient.TABLE_STATE, view);
    }
  }

  // --- helpers -------------------------------------------------------

  private async enterRoom(
    socket: Socket,
    tournamentId: string,
    tableId: string,
    userId: string,
  ): Promise<void> {
    this.tracked.set(socket.id, { tournamentId, tableId, userId });
    await socket.join(ROOM(tournamentId, tableId));
  }

  private viewFor(
    runner: TournamentRunner,
    tournamentId: string,
    tableId: string,
    userId: string | null,
  ): TableStateView | null {
    const table = runner.getTable(tableId);
    if (!table) return null;
    const view = projectTableState({
      table: table.tableMeta(),
      state: table.gameState as GameState,
      roster: table.roster(),
      revealedSeats: table.revealed,
      viewerUserId: userId,
    });
    return { ...view, tournamentId };
  }

  private seatOf(runner: TournamentRunner, tableId: string, userId: string | null): number | null {
    if (!userId) return null;
    return runner.getTable(tableId)?.seatOf(userId) ?? null;
  }

  private userOf(socket: { data: unknown }): string | null {
    return (socket.data as { user?: { userId: string } }).user?.userId ?? null;
  }

  private userHasAnotherSocket(tournamentId: string, userId: string, exceptId: string): boolean {
    for (const [socketId, t] of this.tracked) {
      if (socketId !== exceptId && t.tournamentId === tournamentId && t.userId === userId) {
        return true;
      }
    }
    return false;
  }

  private toUser(
    tournamentId: string,
    userId: string,
    event: string,
    payload: Record<string, unknown>,
  ): void {
    for (const [socketId, t] of this.tracked) {
      if (t.tournamentId === tournamentId && t.userId === userId) {
        this.server.sockets.sockets.get(socketId)?.emit(event, payload);
      }
    }
  }
}
