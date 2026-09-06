import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ClientToServer,
  ServerToClient,
  type HandUpdateEvent,
  type TableChatMessage,
  type TableStateView,
  type TableTimeChargeMessage,
  type TournamentAssignment,
  type TournamentElimination,
  type TournamentFinished,
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
  /** Tournament only: your finishing position once you bust, else null. */
  eliminated: number | null;
  /** Tournament only: the final standings once the event ends, else null. */
  finished: TournamentFinished | null;
  clearError: () => void;
  takeSeat: (seatNumber: number, buyIn: number) => Promise<string | null>;
  leaveSeat: () => Promise<void>;
  act: (action: WirePlayerAction) => Promise<string | null>;
  toggleSitOut: (sittingOut: boolean) => void;
  sendChat: (text: string) => void;
}

export interface UseTableOptions {
  /** When true, `id` is a tournamentId: the server routes state/actions to the
   * player's own table and re-routes it on a balance move. There is no join /
   * leave / buy-in / chat - the coordinator owns the seats. */
  tournament?: boolean;
}

const FEED_MAX = 40;

export function useTable(id: string, opts: UseTableOptions = {}): UseTable {
  const isTournament = opts.tournament === true;

  const [view, setView] = useState<TableStateView | null>(null);
  const [connected, setConnected] = useState<boolean>(!!getSocket()?.connected);
  const [error, setError] = useState<WsError | null>(null);
  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [chat, setChat] = useState<TableChatMessage[]>([]);
  const [eliminated, setEliminated] = useState<number | null>(null);
  const [finished, setFinished] = useState<TournamentFinished | null>(null);

  const viewRef = useRef<TableStateView | null>(null);
  viewRef.current = view;
  const seqRef = useRef(0);
  const feedIdRef = useRef(0);

  const pushFeed = useCallback((text: string) => {
    feedIdRef.current += 1;
    const entry = { id: `f${feedIdRef.current}`, text };
    setFeed((prev) => [...prev.slice(-(FEED_MAX - 1)), entry]);
  }, []);

  const nameForSeat = useCallback((seat: number): string => {
    const s = viewRef.current?.seats.find((x) => x.seatNumber === seat);
    return s?.username ?? `Seat ${seat + 1}`;
  }, []);

  const watch = useCallback((): Promise<{ ok: true } | { error: string }> => {
    return isTournament ? tableSocket.watchTournament(id) : tableSocket.watch(id);
  }, [id, isTournament]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const mine = (next: TableStateView): boolean =>
      isTournament ? next.tournamentId === id : next.tableId === id;

    const onState = (next: TableStateView): void => {
      if (mine(next)) setView(next);
    };
    const onUpdate = (ev: HandUpdateEvent): void => {
      const line = describeEvent(ev, nameForSeat);
      if (line) pushFeed(line);
    };
    const onChat = (msg: TableChatMessage): void => {
      if (msg.tableId === id) setChat((prev) => [...prev.slice(-49), msg]);
    };
    const onTimeCharge = (msg: TableTimeChargeMessage): void => {
      if (msg.tableId === id) pushFeed(`Table fee: -${msg.amount}`);
    };
    const onError = (err: WsError): void => setError(err);
    const onConnect = (): void => {
      setConnected(true);
      void watch();
    };
    const onDisconnect = (): void => setConnected(false);
    const onAssignment = (a: TournamentAssignment): void => {
      if (a.tournamentId === id) pushFeed(`Seated at ${a.tableId.split(':').pop() ?? 'a table'}`);
    };
    const onEliminated = (e: TournamentElimination): void => {
      if (e.tournamentId === id) {
        setEliminated(e.finishPosition);
        pushFeed(`You busted in ${ordinal(e.finishPosition)}`);
      }
    };
    const onFinished = (f: TournamentFinished): void => {
      if (f.tournamentId === id) setFinished(f);
    };

    socket.on(ServerToClient.TABLE_STATE, onState);
    socket.on(ServerToClient.HAND_UPDATE, onUpdate);
    socket.on(ClientToServer.TABLE_CHAT, onChat);
    socket.on(ServerToClient.TIME_CHARGE, onTimeCharge);
    socket.on(ServerToClient.ERROR, onError);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on(ServerToClient.TOURNAMENT_ASSIGNMENT, onAssignment);
    socket.on(ServerToClient.TOURNAMENT_ELIMINATED, onEliminated);
    socket.on(ServerToClient.TOURNAMENT_FINISHED, onFinished);

    void watch().then((ack) => {
      if ('error' in ack) setError({ code: 'WATCH_FAILED', message: ack.error });
    });

    return () => {
      if (isTournament) {
        // A tournament player keeps their seat; unwatch just stops the stream.
        tableSocket.unwatchTournament(id);
      } else {
        void tableSocket.leave(id);
        tableSocket.unwatch(id);
      }
      socket.off(ServerToClient.TABLE_STATE, onState);
      socket.off(ServerToClient.HAND_UPDATE, onUpdate);
      socket.off(ClientToServer.TABLE_CHAT, onChat);
      socket.off(ServerToClient.TIME_CHARGE, onTimeCharge);
      socket.off(ServerToClient.ERROR, onError);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off(ServerToClient.TOURNAMENT_ASSIGNMENT, onAssignment);
      socket.off(ServerToClient.TOURNAMENT_ELIMINATED, onEliminated);
      socket.off(ServerToClient.TOURNAMENT_FINISHED, onFinished);
    };
  }, [id, isTournament, nameForSeat, pushFeed, watch]);

  const takeSeat = useCallback(
    async (seatNumber: number, buyIn: number): Promise<string | null> => {
      if (isTournament) return 'you cannot buy in to a tournament';
      const ack = await tableSocket.join(id, seatNumber, buyIn);
      return 'error' in ack ? ack.error : null;
    },
    [id, isTournament],
  );

  const leaveSeat = useCallback(async (): Promise<void> => {
    if (!isTournament) await tableSocket.leave(id);
  }, [id, isTournament]);

  const act = useCallback(
    async (action: WirePlayerAction): Promise<string | null> => {
      const handId = viewRef.current?.handId;
      if (!handId) return 'no hand in progress';
      seqRef.current += 1;
      const ack = isTournament
        ? await tableSocket.actTournament({
            tournamentId: id,
            handId,
            clientSeq: seqRef.current,
            action,
          })
        : await tableSocket.act({ tableId: id, handId, clientSeq: seqRef.current, action });
      return 'error' in ack ? ack.error : null;
    },
    [id, isTournament],
  );

  const toggleSitOut = useCallback(
    (sittingOut: boolean) => {
      if (isTournament) return;
      if (sittingOut) tableSocket.sitOut(id);
      else tableSocket.sitIn(id);
    },
    [id, isTournament],
  );

  const sendChat = useCallback(
    (text: string) => {
      if (isTournament) return;
      const trimmed = text.trim();
      if (trimmed) tableSocket.chat(id, trimmed);
    },
    [id, isTournament],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    view,
    connected,
    error,
    feed,
    chat,
    eliminated,
    finished,
    clearError,
    takeSeat,
    leaveSeat,
    act,
    toggleSitOut,
    sendChat,
  };
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}
