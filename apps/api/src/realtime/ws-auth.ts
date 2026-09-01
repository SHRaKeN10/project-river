import type { Socket } from 'socket.io';
import type { SessionBlocklistService } from '../auth/session-blocklist.service';
import type { TokenService } from '../auth/token.service';
import type { UserRole } from '@river/shared-types';

export interface SocketUser {
  userId: string;
  role: UserRole;
  sessionId: string;
}

/**
 * Socket.IO middleware: verifies the access token supplied in the handshake
 * (`auth.token` or `Authorization: Bearer`) and stamps the socket with the
 * user. Unauthenticated sockets are refused before any event is handled.
 */
export function createWsAuthMiddleware(tokens: TokenService, blocklist: SessionBlocklistService) {
  return (socket: Socket, next: (err?: Error) => void): void => {
    void (async () => {
      try {
        const raw =
          (socket.handshake.auth?.token as string | undefined) ??
          extractBearer(socket.handshake.headers.authorization);
        if (!raw) throw new Error('missing access token');

        const payload = tokens.verifyAccessToken(raw);
        if (await blocklist.isRevoked(payload.sid)) throw new Error('session revoked');
        const user: SocketUser = {
          userId: payload.sub,
          role: payload.role,
          sessionId: payload.sid,
        };
        (socket.data as { user?: SocketUser }).user = user;
        next();
      } catch (err) {
        next(new Error(`unauthorized: ${(err as Error).message}`));
      }
    })();
  };
}

export function socketUser(socket: Socket): SocketUser {
  const user = (socket.data as { user?: SocketUser }).user;
  if (!user) throw new Error('socket is not authenticated');
  return user;
}

function extractBearer(header: string | undefined): string | undefined {
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length).trim() || undefined;
}
