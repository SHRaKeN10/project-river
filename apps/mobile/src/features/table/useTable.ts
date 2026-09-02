import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ClientToServer,
  ServerToClient,
  type HandUpdateEvent,
  type TableChatMessage,
  type TableStateView,
  type WirePlayerAction,
  type WsError,
} from '@river/shared-types';
import { getSocket } from '../realtime/socket';
import { describeEvent } from './layout';
import { tableSocket } from './socket';

export interface FeedLine {
  id: string;
  text: string;
}

export interface UseTable {
  view: TableStateView | null;
  connected: boolean;
  error: WsError | null;
  feed: FeedLine[];
  chat: TableChatMessage[];
  clearError: () => void;
  takeSeat: (seatNumber: number, buyIn: number) => Promise<string | null>;
  leaveSeat: () => Promise<void>;
  act: (action: WirePlayerAction) => Promise<string | null>;
  toggleSitOut: (sittingOut: boolean) => void;
  sendChat: (text: string) => void;
}

const FEED_MAX = 40;

export function useTable(tableId: string): UseTable {
  const [view, setView] = useState<TableStateView | null>(null);
  const [connected, setConnected] = useState<boolean>(!!getSocket()?.connected);
  const [error, setError] = useState<WsError | null>(null);
  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [chat, setChat] = useState<TableChatMessage[]>([]);

  const viewRef = useRef<TableStateView | null>(null);
  viewRef.current = view;
  const seqRef = useRef(0);
  const feedIdRef = useRef(0);

  const nameForSeat = useCallback((seat: number): string => {
    const s = viewRef.current?.seats.find((x) => x.seatNumber === seat);
    return s?.username ?? `Seat ${seat + 1}`;
  }, []);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const onState = (next: TableStateView): void => {
      if (next.tableId === tableId) setView(next);
    };
    const onUpdate = (ev: HandUpdateEvent): void => {
      const line = describeEvent(ev, nameForSeat);
      if (!line) return;
      feedIdRef.current += 1;
      const entry = { id: `f${feedIdRef.current}`, text: line };
      setFeed((prev) => [...prev.slice(-(FEED_MAX - 1)), entry]);
    };
    const onChat = (msg: TableChatMessage): void => {
      if (msg.tableId === tableId) setChat((prev) => [...prev.slice(-49), msg]);
    };
    const onError = (err: WsError): void => setError(err);
    const onConnect = (): void => {
      setConnected(true);
      void tableSocket.watch(tableId);
    };
    const onDisconnect = (): void => setConnected(false);

    socket.on(ServerToClient.TABLE_STATE, onState);
    socket.on(ServerToClient.HAND_UPDATE, onUpdate);
    socket.on(ClientToServer.TABLE_CHAT, onChat);
    socket.on(ServerToClient.ERROR, onError);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    void tableSocket.watch(tableId).then((ack) => {
      if ('error' in ack) setError({ code: 'WATCH_FAILED', message: ack.error });
    });

    return () => {
      // Leaving the table screen stands the player up (a no-op if they were
      // only spectating), then drops the room subscription. This keeps every
      // exit path consistent - in-app back button, OS/hardware back, or a
      // navigation reset.
      void tableSocket.leave(tableId);
      tableSocket.unwatch(tableId);
      socket.off(ServerToClient.TABLE_STATE, onState);
      socket.off(ServerToClient.HAND_UPDATE, onUpdate);
      socket.off(ClientToServer.TABLE_CHAT, onChat);
      socket.off(ServerToClient.ERROR, onError);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, [tableId, nameForSeat]);

  const takeSeat = useCallback(
    async (seatNumber: number, buyIn: number): Promise<string | null> => {
      const ack = await tableSocket.join(tableId, seatNumber, buyIn);
      return 'error' in ack ? ack.error : null;
    },
    [tableId],
  );

  const leaveSeat = useCallback(async (): Promise<void> => {
    await tableSocket.leave(tableId);
  }, [tableId]);

  const act = useCallback(
    async (action: WirePlayerAction): Promise<string | null> => {
      const handId = viewRef.current?.handId;
      if (!handId) return 'no hand in progress';
      seqRef.current += 1;
      const ack = await tableSocket.act({
        tableId,
        handId,
        clientSeq: seqRef.current,
        action,
      });
      return 'error' in ack ? ack.error : null;
    },
    [tableId],
  );

  const toggleSitOut = useCallback(
    (sittingOut: boolean) => {
      if (sittingOut) tableSocket.sitOut(tableId);
      else tableSocket.sitIn(tableId);
    },
    [tableId],
  );

  const sendChat = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed) tableSocket.chat(tableId, trimmed);
    },
    [tableId],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    view,
    connected,
    error,
    feed,
    chat,
    clearError,
    takeSeat,
    leaveSeat,
    act,
    toggleSitOut,
    sendChat,
  };
}
