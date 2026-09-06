import type { Socket } from 'socket.io-client';
import {
  ClientToServer,
  type TableActionPayload,
  type TournamentActionPayload,
  type WirePlayerAction,
} from '@river/shared-types';
import { getSocket } from '../realtime/socket';

type Ack = { ok: true } | { error: string };

function emitAck(socket: Socket, event: string, payload: unknown): Promise<Ack> {
  return new Promise((resolve) => {
    socket.timeout(8000).emit(event, payload, (err: unknown, res: Ack) => {
      if (err) resolve({ error: 'the table did not respond' });
      else resolve(res ?? { ok: true });
    });
  });
}

/** Thin, promisified wrappers over the poker gateway. All require a live socket
 * (the app connects it once on auth). */
export const tableSocket = {
  watch: (tableId: string): Promise<Ack> => {
    const s = getSocket();
    if (!s) return Promise.resolve({ error: 'not connected' });
    return emitAck(s, ClientToServer.TABLE_WATCH, { tableId });
  },
  unwatch: (tableId: string): void => {
    getSocket()?.emit(ClientToServer.TABLE_UNWATCH, { tableId });
  },
  join: (tableId: string, seatNumber: number, buyIn: number): Promise<Ack> => {
    const s = getSocket();
    if (!s) return Promise.resolve({ error: 'not connected' });
    return emitAck(s, ClientToServer.TABLE_JOIN, { tableId, seatNumber, buyIn });
  },
  leave: (tableId: string): Promise<Ack> => {
    const s = getSocket();
    if (!s) return Promise.resolve({ error: 'not connected' });
    return emitAck(s, ClientToServer.TABLE_LEAVE, { tableId });
  },
  act: (payload: TableActionPayload): Promise<Ack> => {
    const s = getSocket();
    if (!s) return Promise.resolve({ error: 'not connected' });
    return emitAck(s, ClientToServer.PLAYER_ACTION, payload);
  },
  sitOut: (tableId: string): void => {
    getSocket()?.emit(ClientToServer.PLAYER_SIT_OUT, { tableId });
  },
  sitIn: (tableId: string): void => {
    getSocket()?.emit(ClientToServer.PLAYER_RETURN, { tableId });
  },
  setStraddle: (tableId: string, on: boolean): void => {
    getSocket()?.emit(ClientToServer.PLAYER_STRADDLE, { tableId, on });
  },
  setRunItTwice: (tableId: string, on: boolean): void => {
    getSocket()?.emit(ClientToServer.PLAYER_RUN_IT_TWICE, { tableId, on });
  },
  chat: (tableId: string, text: string): void => {
    getSocket()?.emit(ClientToServer.TABLE_CHAT, { tableId, text });
  },

  // --- tournaments: the server routes to the player's own table ---------
  watchTournament: (tournamentId: string): Promise<Ack> => {
    const s = getSocket();
    if (!s) return Promise.resolve({ error: 'not connected' });
    return emitAck(s, ClientToServer.TOURNAMENT_WATCH, { tournamentId });
  },
  unwatchTournament: (tournamentId: string): void => {
    getSocket()?.emit(ClientToServer.TOURNAMENT_UNWATCH, { tournamentId });
  },
  actTournament: (payload: TournamentActionPayload): Promise<Ack> => {
    const s = getSocket();
    if (!s) return Promise.resolve({ error: 'not connected' });
    return emitAck(s, ClientToServer.TOURNAMENT_ACTION, payload);
  },
};

export type { WirePlayerAction };
