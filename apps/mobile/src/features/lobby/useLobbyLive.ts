import { useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import {
  LobbyClientToServer,
  LobbyServerToClient,
  type LobbyTableDelta,
  type LobbyTableView,
} from '@river/shared-types';
import { getSocket } from '../realtime/socket';
import { lobbyKeys, useApplyLobbyDelta } from './queries';

interface Options {
  /** Fired when a seat opens up at a table this user is waitlisted for. */
  onSeatAvailable?: (tableId: string) => void;
}

/**
 * Joins the `lobby` room while the screen is focused: a full `lobby:tables`
 * snapshot refreshes the cache, `lobby:update` deltas patch it in place, and
 * `waitlist:seatAvailable` fires the callback.
 */
export function useLobbyLive({ onSeatAvailable }: Options = {}): void {
  const qc = useQueryClient();
  const applyDelta = useApplyLobbyDelta();

  useFocusEffect(
    useCallback(() => {
      const socket = getSocket();
      if (!socket) return;

      const onTables = (tables: LobbyTableView[]): void => {
        qc.setQueryData(lobbyKeys.all, tables);
      };
      const onUpdate = (delta: LobbyTableDelta): void => applyDelta(delta);
      const onWaitlist = (payload: { tableId: string }): void => onSeatAvailable?.(payload.tableId);
      const subscribe = (): void => {
        socket.emit(LobbyClientToServer.LOBBY_SUBSCRIBE, {});
      };

      socket.on(LobbyServerToClient.LOBBY_TABLES, onTables);
      socket.on(LobbyServerToClient.LOBBY_UPDATE, onUpdate);
      socket.on(LobbyServerToClient.WAITLIST_SEAT_AVAILABLE, onWaitlist);
      socket.on('connect', subscribe); // re-subscribe after a reconnect
      subscribe();

      return () => {
        socket.emit(LobbyClientToServer.LOBBY_UNSUBSCRIBE);
        socket.off('connect', subscribe);
        socket.off(LobbyServerToClient.LOBBY_TABLES, onTables);
        socket.off(LobbyServerToClient.LOBBY_UPDATE, onUpdate);
        socket.off(LobbyServerToClient.WAITLIST_SEAT_AVAILABLE, onWaitlist);
      };
    }, [qc, applyDelta, onSeatAvailable]),
  );
}
