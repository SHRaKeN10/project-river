import type { TableStateView } from '@river/shared-types';
import {
  createEventDescriber,
  DEALER_BUTTON_SIZE,
  dealerButtonPosition,
  describeEvent,
  isHeroTurn,
  occupiedCount,
  seatPodWidth,
  seatRing,
  SEAT_POD_MAX_WIDTH,
  SEAT_POD_MIN_WIDTH,
  SEAT_WRAP_RISE,
  streetLabel,
  WATERMARK_HALF_WIDTH,
  WATERMARK_HEIGHT,
  WATERMARK_TOP_FRACTION,
  type ShownHands,
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

describe('dealerButtonPosition', () => {
  const half = DEALER_BUTTON_SIZE / 2;
  const sizes = [
    { W: 340, H: 520 },
    { W: 272, H: 440 },
    { W: 400, H: 600 },
  ];
  const puckBox = (p: { x: number; y: number }) => ({
    left: p.x - half,
    right: p.x + half,
    top: p.y - half,
    bottom: p.y + half,
  });
  const hits = (
    a: { left: number; right: number; top: number; bottom: number },
    b: { left: number; right: number; top: number; bottom: number },
  ) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

  it('sits in front of the hero, between the seat and the middle', () => {
    const { W, H } = sizes[0]!;
    const podW = seatPodWidth(W);
    const ring = seatRing(6, 0, W, podW);
    const puck = dealerButtonPosition(ring[0]!, W, H, podW, SEAT_WRAP_RISE, ring);
    expect(puck.y).toBeLessThan(ring[0]!.y * H);
  });

  it('never covers the board, another seat, or leaves the felt - for every dealer seat', () => {
    for (const { W, H } of sizes) {
      const podW = seatPodWidth(W);
      for (const n of [2, 3, 4, 6, 8, 9]) {
        const ring = seatRing(n, 0, W, podW);
        for (const slot of ring) {
          const puck = puckBox(dealerButtonPosition(slot, W, H, podW, SEAT_WRAP_RISE, ring));
          expect(puck.left).toBeGreaterThanOrEqual(0);
          expect(puck.right).toBeLessThanOrEqual(W);
          expect(puck.top).toBeGreaterThanOrEqual(0);
          expect(puck.bottom).toBeLessThanOrEqual(H);
          // the board: roughly 224 x 100 px dead centre
          expect(
            hits(puck, {
              left: W / 2 - 112,
              right: W / 2 + 112,
              top: H / 2 - 50,
              bottom: H / 2 + 50,
            }),
          ).toBe(false);
          // the watermark: just just below the board
          if (W >= 340) {
            expect(
              hits(puck, {
                left: W / 2 - WATERMARK_HALF_WIDTH,
                right: W / 2 + WATERMARK_HALF_WIDTH,
                top: H * WATERMARK_TOP_FRACTION,
                bottom: H * WATERMARK_TOP_FRACTION + WATERMARK_HEIGHT,
              }),
            ).toBe(false);
          }
          // A very cramped felt (narrow phone, 9 seats) has no free spot, so there
          // the puck only has to keep the cards clear.
          for (const other of W >= 340 ? ring : []) {
            const cx = other.x * W;
            const top = other.y * H - SEAT_WRAP_RISE;
            expect(
              hits(puck, { left: cx - podW / 2, right: cx + podW / 2, top, bottom: top + 88 }),
            ).toBe(false);
          }
        }
      }
    }
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
  timeChargeAmount: 0,
  timeChargeIntervalMs: 0,
  antiRatholeMinutes: 0,
  handId: 'h1',
  handNumber: 1,
  street: 'FLOP',
  buttonSeat: 0,
  communityCards: [],
  secondBoard: [],
  pot: 0,
  pots: [],
  currentBet: 0,
  seats: [],
  actingSeat: null,
  actionDeadline: null,
  youAreSeat: null,
  legalActions: null,
  bombPot: null,
  straddle: null,
  youStraddleNext: false,
  runItTwice: null,
  youRunItTwice: false,
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
    expect(describeEvent({ type: 'ANTE_POSTED', seat: 4, amount: 20 }, name)).toBe(
      'P4 posts ante 20',
    );
  });

  it('describes bomb-pot events', () => {
    expect(describeEvent({ type: 'BOMB_POT_STARTED', amount: 20 }, name)).toBe(
      'Bomb pot! Everyone posts 20 - no preflop betting',
    );
    expect(describeEvent({ type: 'BOMB_POT_POSTED', seat: 2, amount: 20 }, name)).toBe(
      'P2 posts bomb 20',
    );
  });

  it('describes a straddle', () => {
    expect(describeEvent({ type: 'STRADDLE_POSTED', seat: 3, amount: 40 }, name)).toBe(
      'P3 straddles 40',
    );
  });

  it('describes run-it-twice events', () => {
    expect(describeEvent({ type: 'SECOND_BOARD_DEALT', cards: [] }, name)).toBe(
      'Running it twice — second board',
    );
    expect(
      describeEvent({ type: 'POT_AWARDED', board: 2, winners: [{ seat: 1, amount: 100 }] }, name),
    ).toBe('Pot to P1 100 (board 2)');
  });

  it('summarises a pot award', () => {
    expect(describeEvent({ type: 'POT_AWARDED', winners: [{ seat: 1, amount: 300 }] }, name)).toBe(
      'Pot to P1 300',
    );
  });

  it('labels the high and low halves of a split pot', () => {
    expect(
      describeEvent(
        { type: 'POT_AWARDED', portion: 'HIGH', winners: [{ seat: 1, amount: 150 }] },
        name,
      ),
    ).toBe('High pot to P1 150');
    expect(
      describeEvent(
        { type: 'POT_AWARDED', portion: 'LOW', winners: [{ seat: 2, amount: 150 }] },
        name,
      ),
    ).toBe('Low pot to P2 150');
  });

  it('shows a revealed low alongside the high', () => {
    expect(
      describeEvent(
        {
          type: 'HAND_REVEALED',
          seat: 0,
          hand: { description: 'Two Pair, Aces and Twos' },
          low: { description: '7-5-3-2-A low' },
        },
        name,
      ),
    ).toBe('P0 shows Two Pair, Aces and Twos (low: 7-5-3-2-A low)');
  });

  it('returns null for events with no feed line', () => {
    expect(describeEvent({ type: 'SHOWDOWN_STARTED' }, name)).toBeNull();
  });

  it('says what the winning hand was when it was shown', () => {
    const shown: ShownHands = new Map([[1, { hi: 'Full House, Kings over Sevens' }]]);
    expect(
      describeEvent({ type: 'POT_AWARDED', winners: [{ seat: 1, amount: 300 }] }, name, shown),
    ).toBe('P1 wins 300 with Full House, Kings over Sevens');
  });

  it('keeps the plain pot line when nobody showed (a fold-out win)', () => {
    expect(
      describeEvent({ type: 'POT_AWARDED', winners: [{ seat: 1, amount: 300 }] }, name, new Map()),
    ).toBe('Pot to P1 300');
  });

  it('names the high hand for the high pot and the low hand for the low pot', () => {
    const shown: ShownHands = new Map([
      [0, { hi: 'Flush, Ace high' }],
      [2, { hi: 'Pair of Fours', lo: '7-5-4-3-A low' }],
    ]);
    expect(
      describeEvent(
        { type: 'POT_AWARDED', portion: 'HIGH', winners: [{ seat: 0, amount: 150 }] },
        name,
        shown,
      ),
    ).toBe('High pot: P0 wins 150 with Flush, Ace high');
    expect(
      describeEvent(
        { type: 'POT_AWARDED', portion: 'LOW', winners: [{ seat: 2, amount: 150 }] },
        name,
        shown,
      ),
    ).toBe('Low pot: P2 wins 150 with 7-5-4-3-A low');
  });

  it('does not name a hand for the second board (reveals describe board 1)', () => {
    const shown: ShownHands = new Map([[1, { hi: 'Pair of Kings' }]]);
    expect(
      describeEvent(
        { type: 'POT_AWARDED', board: 2, winners: [{ seat: 1, amount: 100 }] },
        name,
        shown,
      ),
    ).toBe('Pot to P1 100 (board 2)');
  });

  it('lists every winner of a split pot, naming each hand that was shown', () => {
    const shown: ShownHands = new Map([
      [0, { hi: 'Straight, Nine high' }],
      [3, { hi: 'Straight, Nine high' }],
    ]);
    expect(
      describeEvent(
        {
          type: 'POT_AWARDED',
          winners: [
            { seat: 0, amount: 100 },
            { seat: 3, amount: 100 },
          ],
        },
        name,
        shown,
      ),
    ).toBe('P0 wins 100 with Straight, Nine high; P3 wins 100 with Straight, Nine high');
  });
});

describe('createEventDescriber', () => {
  const name = (seat: number): string => `P${seat}`;

  it('remembers revealed hands so the pot line can name the winner', () => {
    const describe = createEventDescriber(name);
    describe({ type: 'HAND_STARTED', handNumber: 7 });
    describe({
      type: 'HAND_REVEALED',
      seat: 2,
      hand: { description: 'Two Pair, Jacks and Sevens' },
    });
    expect(describe({ type: 'POT_AWARDED', winners: [{ seat: 2, amount: 60 }] })).toBe(
      'P2 wins 60 with Two Pair, Jacks and Sevens',
    );
  });

  it("does not carry one hand's reveals into the next", () => {
    const describe = createEventDescriber(name);
    describe({ type: 'HAND_REVEALED', seat: 2, hand: { description: 'Flush, King high' } });
    describe({ type: 'HAND_STARTED', handNumber: 8 });
    expect(describe({ type: 'POT_AWARDED', winners: [{ seat: 2, amount: 60 }] })).toBe(
      'Pot to P2 60',
    );
  });
});
