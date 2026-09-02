import { useEffect, useState } from 'react';
import { getSocket } from './socket';

/**
 * Tracks the shared socket's connection state so a screen can show a
 * "reconnecting" hint. Returns `true` when there is no socket yet (nothing to
 * warn about until the user is past auth).
 */
export function useSocketConnected(): boolean {
  const [connected, setConnected] = useState<boolean>(() => {
    const s = getSocket();
    return s ? s.connected : true;
  });

  useEffect(() => {
    const socket = getSocket();
    if (!socket) {
      setConnected(true);
      return;
    }
    setConnected(socket.connected);
    const onConnect = (): void => setConnected(true);
    const onDisconnect = (): void => setConnected(false);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, []);

  return connected;
}
