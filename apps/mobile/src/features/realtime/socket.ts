import { io, type Socket } from 'socket.io-client';
import { config } from '../../config';

/**
 * A single shared socket connection for the whole app (lobby + table live on
 * the same server). Call `connectSocket` after auth, `disconnectSocket` on
 * logout. `getSocket` returns the live instance or null.
 */
let socket: Socket | null = null;

export function connectSocket(accessToken: string): Socket {
  if (socket) {
    socket.auth = { token: accessToken };
    if (!socket.connected) socket.connect();
    return socket;
  }
  socket = io(config.socketUrl, {
    auth: { token: accessToken },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5_000,
  });
  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}
