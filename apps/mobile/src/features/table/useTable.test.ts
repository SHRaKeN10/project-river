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
  nextTimeChargeAt: null,
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

  it('turns a time-charge event into a feed line naming the charged seat', async () => {
    const { result } = renderHook(() => useTable('t-1'));
    act(() => mockFake.server('table:state', view()));
    act(() => mockFake.server('table:timeCharge', { tableId: 't-1', seatNumber: 0, amount: 5 }));
    await waitFor(() => expect(result.current.feed.at(-1)?.text).toBe('Table fee: Me -5'));

    // a charge for a different table is ignored
    act(() => mockFake.server('table:timeCharge', { tableId: 'other', seatNumber: 0, amount: 9 }));
    expect(result.current.feed.at(-1)?.text).toBe('Table fee: Me -5');
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
});
