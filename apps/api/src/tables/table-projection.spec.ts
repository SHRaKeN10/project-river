import {
  createTableConfig,
  initGameState,
  reduce,
  SeededRandomProvider,
} from '@river/poker-engine';
import { projectTableState, type RosterEntry, type TableMeta } from './table-projection';

const meta: TableMeta = {
  id: 't-1',
  name: 'Test Table',
  gameType: 'NLHE',
  smallBlind: 10,
  bigBlind: 20,
  maxSeats: 6,
  minBuyIn: 400,
  maxBuyIn: 4000,
  timeChargeAmount: 0,
  timeChargeIntervalMs: 0,
  bombPotEnabled: false,
  bombPotIntervalHands: 15,
  bombPotAmount: 0,
  straddleEnabled: false,
  straddleMultiplier: 2,
  runItTwiceEnabled: false,
};

const roster = new Map<number, RosterEntry>([
  [
    0,
    {
      userId: 'u-alice',
      username: 'alice',
      avatarUrl: null,
      connected: true,
      stack: 1000,
      sittingOut: false,
      straddleOn: false,
      runItTwiceOn: false,
      lastTimeChargeAt: 0,
    },
  ],
  [
    1,
    {
      userId: 'u-bob',
      username: 'bob',
      avatarUrl: null,
      connected: true,
      stack: 1000,
      sittingOut: false,
      straddleOn: false,
      runItTwiceOn: false,
      lastTimeChargeAt: 0,
    },
  ],
  [
    2,
    {
      userId: 'u-cara',
      username: 'cara',
      avatarUrl: null,
      connected: true,
      stack: 1000,
      sittingOut: false,
      straddleOn: false,
      runItTwiceOn: false,
      lastTimeChargeAt: 0,
    },
  ],
]);

function midHandState() {
  const config = createTableConfig({ smallBlind: 10, bigBlind: 20, maxSeats: 6 });
  const fresh = initGameState({
    tableId: 't-1',
    config,
    players: [
      { userId: 'u-alice', seatNumber: 0, stack: 1000 },
      { userId: 'u-bob', seatNumber: 1, stack: 1000 },
      { userId: 'u-cara', seatNumber: 2, stack: 1000 },
    ],
  });
  return reduce(
    fresh,
    { type: 'START_HAND', handId: 'h-1', handNumber: 1, previousPositions: null },
    new SeededRandomProvider(1),
  ).state;
}

describe('projectTableState', () => {
  const state = midHandState();

  it('shows the viewer only their own hole cards', () => {
    const view = projectTableState({
      table: meta,
      state,
      roster,
      revealedSeats: new Set(),
      viewerUserId: 'u-bob',
    });
    const bobSeat = view.seats.find((s) => s.userId === 'u-bob');
    const aliceSeat = view.seats.find((s) => s.userId === 'u-alice');
    expect(bobSeat?.holeCards).toHaveLength(2);
    expect(aliceSeat?.holeCards).toBeNull();
    expect(view.youAreSeat).toBe(1);
  });

  it('never includes the deck or seed', () => {
    const view = projectTableState({
      table: meta,
      state,
      roster,
      revealedSeats: new Set(),
      viewerUserId: 'u-alice',
    });
    expect(JSON.stringify(view)).not.toContain('cursor');
    expect(JSON.stringify(view)).not.toMatch(/"deck"/);
  });

  it('reveals a seat once it is in revealedSeats (showdown)', () => {
    const view = projectTableState({
      table: meta,
      state,
      roster,
      revealedSeats: new Set([0]),
      viewerUserId: 'u-bob',
    });
    expect(view.seats.find((s) => s.userId === 'u-alice')?.holeCards).toHaveLength(2);
  });

  it('gives legalActions only to the player whose turn it is', () => {
    const actingSeat = state.actingSeat!;
    const actingUser = roster.get(actingSeat)!.userId;
    const otherUser = [...roster.values()].find((r) => r.userId !== actingUser)!.userId;

    const actorView = projectTableState({
      table: meta,
      state,
      roster,
      revealedSeats: new Set(),
      viewerUserId: actingUser,
    });
    const otherView = projectTableState({
      table: meta,
      state,
      roster,
      revealedSeats: new Set(),
      viewerUserId: otherUser,
    });
    expect(actorView.legalActions).not.toBeNull();
    expect(actorView.legalActions!.length).toBeGreaterThan(0);
    expect(otherView.legalActions).toBeNull();
  });

  it('a spectator sees no hole cards and no seat', () => {
    const view = projectTableState({
      table: meta,
      state,
      roster,
      revealedSeats: new Set(),
      viewerUserId: null,
    });
    expect(view.youAreSeat).toBeNull();
    expect(view.seats.every((s) => s.holeCards === null)).toBe(true);
  });

  it('between hands reports stacks from the roster and hides the button', () => {
    const idle = initGameState({
      tableId: 't-1',
      config: createTableConfig({ smallBlind: 10, bigBlind: 20, maxSeats: 6 }),
      players: [],
    });
    const view = projectTableState({
      table: meta,
      state: idle,
      roster,
      revealedSeats: new Set(),
      viewerUserId: 'u-alice',
    });
    expect(view.buttonSeat).toBeNull();
    expect(view.handId).toBeNull();
    expect(view.seats.find((s) => s.userId === 'u-alice')?.stack).toBe(1000);
  });
});
