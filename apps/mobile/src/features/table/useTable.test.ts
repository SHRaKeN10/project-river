import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { TableStateView } from '@river/shared-types';
import { useTable } from './useTable';

jest.mock('../realtime/socket', () => ({ getSocket: () => mockFake }));

type Handler = (...args: unknown[]) => void;

class FakeSocket {
  connected = true;
  handlers = new Map<string, Set<Handler>>();
  emitted: { event: string; payload: unknown }[] = [];

  on(event: string, fn: Handler): this {
    (this.handlers.get(event) ?? this.handlers.set(event, new Set()).get(event)!).add(fn);
    return this;
  }
  off(event: string, fn: Handler): this {
    this.handlers.get(event)?.delete(fn);
    return this;
  }
  emit(event: string, payload?: unknown, ack?: (err: unknown, res: unknown) => void): this {
    this.emitted.push({ event, payload });
    ack?.(null, { ok: true });
    return this;
  }
  timeout(): this {
    return this;
  }
  /** test helper: push a server->client event */
  server(event: string, payload: unknown): void {
    for (const fn of this.handlers.get(event) ?? []) fn(payload);
  }
}

let mockFake: FakeSocket;

const view = (over: Partial<TableStateView> = {}): TableStateView => ({
  tableId: 't-1',
  name: 'Test',
  gameType: 'NLHE',
  smallBlind: 5,
  bigBlind: 10,
  maxSeats: 6,
  minBuyIn: 200,
  maxBuyIn: 2000,
  timeChargeAmount: 0,
  timeChargeIntervalMs: 0,
  handId: 'h1',
  handNumber: 1,
  street: 'PREFLOP',
  buttonSeat: 0,
  communityCards: [],
  pot: 30,
  pots: [],
  currentBet: 10,
  seats: [
    {
      seatNumber: 0,
      userId: 'me',
      username: 'Me',
      avatarUrl: null,
      stack: 990,
      currentBet: 10,
      totalInvested: 10,
      status: 'ACTIVE',
      lastAction: null,
      isDealer: true,
      isSmallBlind: false,
      isBigBlind: false,
      connected: true,
      holeCards: ['As', 'Kd'],
    },
  ],
  actingSeat: 0,
  actionDeadline: null,
  youAreSeat: 0,
  legalActions: [{ kind: 'CHECK' }],
  ...over,
});

beforeEach(() => {
  mockFake = new FakeSocket();
});

describe('useTable', () => {
  it('watches on mount and, on unmount, stands up then unwatches', () => {
    const { unmount } = renderHook(() => useTable('t-1'));
    expect(mockFake.emitted.some((e) => e.event === 'table:watch')).toBe(true);
    unmount();
    const events = mockFake.emitted.map((e) => e.event);
    expect(events).toContain('table:leave');
    expect(events).toContain('table:unwatch');
    // leave is sent before the subscription drops
    expect(events.indexOf('table:leave')).toBeLessThan(events.lastIndexOf('table:unwatch'));
  });

  it('adopts table:state snapshots for the matching table only', async () => {
    const { result } = renderHook(() => useTable('t-1'));
    act(() => mockFake.server('table:state', view({ pot: 55 })));
    await waitFor(() => expect(result.current.view?.pot).toBe(55));

    act(() => mockFake.server('table:state', view({ tableId: 'other', pot: 999 })));
    expect(result.current.view?.pot).toBe(55); // ignored
  });

  it('turns hand:update events into feed lines', async () => {
    const { result } = renderHook(() => useTable('t-1'));
    act(() => mockFake.server('table:state', view()));
    act(() => mockFake.server('hand:update', { type: 'PLAYER_FOLDED', seat: 0 }));
    await waitFor(() => expect(result.current.feed.at(-1)?.text).toBe('Me folds'));
  });

  it('turns a time-charge event into a feed line', async () => {
    const { result } = renderHook(() => useTable('t-1'));
    act(() => mockFake.server('table:state', view()));
    act(() => mockFake.server('table:timeCharge', { tableId: 't-1', seatNumber: 0, amount: 5 }));
    await waitFor(() => expect(result.current.feed.at(-1)?.text).toBe('Table fee: -5'));

    // a charge for a different table is ignored
    act(() => mockFake.server('table:timeCharge', { tableId: 'other', seatNumber: 0, amount: 9 }));
    expect(result.current.feed.at(-1)?.text).toBe('Table fee: -5');
  });

  it('surfaces and clears socket errors', async () => {
    const { result } = renderHook(() => useTable('t-1'));
    act(() => mockFake.server('error', { code: 'NOPE', message: 'not your turn' }));
    await waitFor(() => expect(result.current.error?.message).toBe('not your turn'));
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });

  it('sends player actions with a monotonic clientSeq and the live handId', async () => {
    const { result } = renderHook(() => useTable('t-1'));
    act(() => mockFake.server('table:state', view({ handId: 'h9' })));

    await act(async () => {
      await result.current.act({ type: 'CHECK' });
      await result.current.act({ type: 'FOLD' });
    });

    const actions = mockFake.emitted.filter((e) => e.event === 'player:action');
    expect(actions).toHaveLength(2);
    expect((actions[0]!.payload as { handId: string }).handId).toBe('h9');
    expect((actions[0]!.payload as { clientSeq: number }).clientSeq).toBe(1);
    expect((actions[1]!.payload as { clientSeq: number }).clientSeq).toBe(2);
  });

  it('refuses to act with no hand in progress', async () => {
    const { result } = renderHook(() => useTable('t-1'));
    act(() => mockFake.server('table:state', view({ handId: null })));
    let err: string | null = null;
    await act(async () => {
      err = await result.current.act({ type: 'CHECK' });
    });
    expect(err).toBe('no hand in progress');
  });

  describe('tournament mode', () => {
    it('watches by tournamentId and filters state on it, not tableId', async () => {
      const { result, unmount } = renderHook(() => useTable('tourney-1', { tournament: true }));
      expect(mockFake.emitted.some((e) => e.event === 'tournament:watch')).toBe(true);
      expect(mockFake.emitted.some((e) => e.event === 'table:watch')).toBe(false);

      // a state for this tournament (any tableId) is adopted
      act(() =>
        mockFake.server(
          'table:state',
          view({ tableId: 'tourney-1:2', tournamentId: 'tourney-1', pot: 77 }),
        ),
      );
      await waitFor(() => expect(result.current.view?.pot).toBe(77));

      // a state for a different tournament is ignored
      act(() =>
        mockFake.server('table:state', view({ tableId: 'x:0', tournamentId: 'other', pot: 999 })),
      );
      expect(result.current.view?.pot).toBe(77);

      unmount();
      const events = mockFake.emitted.map((e) => e.event);
      expect(events).toContain('tournament:unwatch');
      expect(events).not.toContain('table:leave'); // you don't leave a tournament
    });

    it('routes actions through tournament:action with the tournamentId', async () => {
      const { result } = renderHook(() => useTable('tourney-1', { tournament: true }));
      act(() => mockFake.server('table:state', view({ tournamentId: 'tourney-1', handId: 'h5' })));
      await act(async () => {
        await result.current.act({ type: 'CALL' });
      });
      const a = mockFake.emitted.find((e) => e.event === 'tournament:action');
      expect(a).toBeDefined();
      expect((a!.payload as { tournamentId: string }).tournamentId).toBe('tourney-1');
      expect((a!.payload as { handId: string }).handId).toBe('h5');
      expect(mockFake.emitted.some((e) => e.event === 'player:action')).toBe(false);
    });

    it('surfaces assignment, elimination and finish events', async () => {
      const { result } = renderHook(() => useTable('tourney-1', { tournament: true }));
      act(() =>
        mockFake.server('tournament:assignment', {
          tournamentId: 'tourney-1',
          tableId: 'tourney-1:3',
          seat: 4,
        }),
      );
      await waitFor(() => expect(result.current.feed.at(-1)?.text).toMatch(/Seated/));

      act(() =>
        mockFake.server('tournament:eliminated', { tournamentId: 'tourney-1', finishPosition: 7 }),
      );
      await waitFor(() => expect(result.current.eliminated).toBe(7));

      act(() =>
        mockFake.server('tournament:finished', {
          tournamentId: 'tourney-1',
          results: [{ userId: 'me', position: 7, payout: 0 }],
        }),
      );
      await waitFor(() => expect(result.current.finished?.results).toHaveLength(1));
    });

    it('adopts tournament:clock snapshots for this tournament only', async () => {
      const { result } = renderHook(() => useTable('tourney-1', { tournament: true }));
      const snap = (over: Record<string, unknown> = {}) => ({
        tournamentId: 'tourney-1',
        level: 3,
        smallBlind: 100,
        bigBlind: 200,
        ante: 0,
        isBreak: false,
        levelEndsAt: Date.now() + 60_000,
        levelDurationMs: 600_000,
        serverNow: Date.now(),
        handForHand: false,
        playersLeft: 12,
        placesPaid: 3,
        tableCount: 2,
        ...over,
      });

      act(() => mockFake.server('tournament:clock', snap()));
      await waitFor(() => expect(result.current.clock?.level).toBe(3));

      act(() => mockFake.server('tournament:clock', snap({ tournamentId: 'other', level: 9 })));
      expect(result.current.clock?.level).toBe(3); // ignored
    });

    it('rejects taking a seat / chatting in a tournament', async () => {
      const { result } = renderHook(() => useTable('tourney-1', { tournament: true }));
      let err: string | null = 'x';
      await act(async () => {
        err = await result.current.takeSeat(0, 100);
      });
      expect(err).toMatch(/cannot buy in/i);
    });
  });
});
