import type { TableStateView } from '@river/shared-types';
import {
  describeEvent,
  isHeroTurn,
  occupiedCount,
  seatPodWidth,
  seatRing,
  SEAT_POD_MAX_WIDTH,
  SEAT_POD_MIN_WIDTH,
  streetLabel,
} from './layout';

describe('seatRing', () => {
  it('pins the hero at the bottom-centre of the oval', () => {
    const ring = seatRing(6, 2);
    const hero = ring[2]!;
    expect(hero.x).toBeCloseTo(0.5, 5);
    expect(hero.y).toBeGreaterThan(0.8); // near the bottom edge
  });

  it('returns one slot per seat and keeps them on the ellipse', () => {
    const ring = seatRing(9, 0);
    expect(ring).toHaveLength(9);
    for (const slot of ring) {
      expect(slot.x).toBeGreaterThanOrEqual(0);
      expect(slot.x).toBeLessThanOrEqual(1);
      expect(slot.y).toBeGreaterThanOrEqual(0);
      expect(slot.y).toBeLessThanOrEqual(1);
    }
  });

  it('keeps every pod fully on the felt on a narrow screen', () => {
    const feltWidth = 272; // ~320px phone minus page padding
    const podWidth = seatPodWidth(feltWidth);
    const ring = seatRing(9, 0, feltWidth, podWidth);
    for (const slot of ring) {
      const centrePx = slot.x * feltWidth;
      expect(centrePx - podWidth / 2).toBeGreaterThanOrEqual(0);
      expect(centrePx + podWidth / 2).toBeLessThanOrEqual(feltWidth);
    }
  });

  it('is unchanged when no felt width is given (back-compat)', () => {
    const a = seatRing(6, 2);
    const b = seatRing(6, 2, undefined);
    expect(a).toEqual(b);
    expect(a[0]!.x).toBeGreaterThanOrEqual(0.16);
  });
});

describe('seatPodWidth', () => {
  it('is full width on a roomy screen and floors on a narrow one', () => {
    expect(seatPodWidth(400)).toBe(SEAT_POD_MAX_WIDTH);
    expect(seatPodWidth(200)).toBe(SEAT_POD_MIN_WIDTH);
    expect(seatPodWidth(0)).toBe(SEAT_POD_MAX_WIDTH); // guards bad input
  });

  it('spreads the other seats around (no two slots identical)', () => {
    const ring = seatRing(4, 1);
    const keys = new Set(ring.map((s) => `${s.x.toFixed(3)},${s.y.toFixed(3)}`));
    expect(keys.size).toBe(4);
  });
});

const baseView = (over: Partial<TableStateView>): TableStateView => ({
  tableId: 't',
  name: 'T',
  gameType: 'NLHE',
  smallBlind: 5,
  bigBlind: 10,
  maxSeats: 6,
  minBuyIn: 200,
  maxBuyIn: 2000,
  handId: 'h1',
  handNumber: 1,
  street: 'FLOP',
  buttonSeat: 0,
  communityCards: [],
  pot: 0,
  pots: [],
  currentBet: 0,
  seats: [],
  actingSeat: null,
  actionDeadline: null,
  youAreSeat: null,
  legalActions: null,
  ...over,
});

describe('isHeroTurn', () => {
  it('is true only when it is the viewer’s seat and options are present', () => {
    expect(
      isHeroTurn(baseView({ youAreSeat: 3, actingSeat: 3, legalActions: [{ kind: 'CHECK' }] })),
    ).toBe(true);
    expect(
      isHeroTurn(baseView({ youAreSeat: 3, actingSeat: 2, legalActions: [{ kind: 'CHECK' }] })),
    ).toBe(false);
    expect(isHeroTurn(baseView({ youAreSeat: 3, actingSeat: 3, legalActions: [] }))).toBe(false);
    expect(isHeroTurn(baseView({ youAreSeat: null, actingSeat: 3 }))).toBe(false);
  });
});

describe('occupiedCount', () => {
  it('counts seats with a user', () => {
    const view = baseView({
      seats: [
        { seatNumber: 0, userId: 'a' } as never,
        { seatNumber: 1, userId: null } as never,
        { seatNumber: 2, userId: 'c' } as never,
      ],
    });
    expect(occupiedCount(view)).toBe(2);
  });
});

describe('streetLabel', () => {
  it('maps engine streets to display text', () => {
    expect(streetLabel('PREFLOP')).toBe('Pre-flop');
    expect(streetLabel('COMPLETE')).toBe('Hand complete');
    expect(streetLabel('MYSTERY')).toBe('MYSTERY');
  });
});

describe('describeEvent', () => {
  const name = (seat: number): string => `P${seat}`;

  it('renders common actions', () => {
    expect(describeEvent({ type: 'PLAYER_FOLDED', seat: 1 }, name)).toBe('P1 folds');
    expect(describeEvent({ type: 'PLAYER_CALLED', seat: 2, amount: 40 }, name)).toBe('P2 calls 40');
    expect(describeEvent({ type: 'PLAYER_RAISED', seat: 0, amount: 120 }, name)).toBe(
      'P0 raises to 120',
    );
    expect(describeEvent({ type: 'BLIND_POSTED', seat: 3, amount: 10, blind: 'BIG' }, name)).toBe(
      'P3 posts big blind 10',
    );
  });

  it('summarises a pot award', () => {
    expect(describeEvent({ type: 'POT_AWARDED', winners: [{ seat: 1, amount: 300 }] }, name)).toBe(
      'Pot to P1 300',
    );
  });

  it('returns null for events with no feed line', () => {
    expect(describeEvent({ type: 'SHOWDOWN_STARTED' }, name)).toBeNull();
  });
});
