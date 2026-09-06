import { allIn, call, check, fold, type BettingContext } from '../betting';
import { legalActions } from '../action-validator';
import { type GameEvent } from '../events/events';
import { type GameState, Street, totalPot } from '../game-state/game-state';
import { PlayerStatus } from '../player/player';
import { GameVariant } from '../variant/variant';
import { createTableConfig } from '../table/table';
import { buildDeck } from '../testkit/deckBuilder';
import { HandRunner, type Seat } from '../testkit/handRunner';
import { replayHand, type HandRecord } from './replay';

/**
 * Bomb pots for NLHE cash (ADR-0026). A bomb-pot hand: every dealt-in player
 * posts the bomb amount as dead money (their whole stack, all-in, if short),
 * NO preflop betting round, straight to the flop, then normal NLHE. The blinds
 * are not posted - the bomb contribution replaces them. All the existing
 * side-pot / all-in / showdown / settlement logic is reused unchanged.
 */

const cfg = (over = {}) => createTableConfig({ smallBlind: 5, bigBlind: 10, ...over });
const seats = (stacks: number[]): Seat[] =>
  stacks.map((stack, i) => ({ userId: `u${i}`, seatNumber: i, stack }));
const types = (events: GameEvent[]): string[] => events.map((e) => e.type);
const seatOf = (s: GameState, seat: number) => s.players.find((p) => p.seatNumber === seat)!;
const bombPosts = (events: GameEvent[]) =>
  events.filter(
    (e): e is Extract<GameEvent, { type: 'BOMB_POT_POSTED' }> => e.type === 'BOMB_POT_POSTED',
  );

describe('bomb pot - posting and flow', () => {
  it('a normal (non-bomb) NLHE hand is completely unchanged', () => {
    const h = new HandRunner(cfg(), seats([1000, 1000, 1000]));
    h.startHand(); // no bombPot
    expect(types(h.events)).toEqual([
      'HAND_STARTED',
      'BLIND_POSTED',
      'BLIND_POSTED',
      'HOLE_CARDS_DEALT',
    ]);
    expect(h.state.street).toBe(Street.Preflop);
    expect(bombPosts(h.events)).toHaveLength(0);
  });

  it('every dealt-in player posts the bomb amount, no blinds, straight to the flop', () => {
    const h = new HandRunner(cfg(), seats([1000, 1000, 1000]));
    h.startHand(undefined, { amount: 25 });

    expect(types(h.events)).toEqual([
      'HAND_STARTED',
      'BOMB_POT_STARTED',
      'BOMB_POT_POSTED',
      'BOMB_POT_POSTED',
      'BOMB_POT_POSTED',
      'HOLE_CARDS_DEALT',
      'FLOP_DEALT',
    ]);
    expect(bombPosts(h.events).map((e) => e.amount)).toEqual([25, 25, 25]);

    // no blind was posted, and nobody has a live "current bet" to call
    expect(h.events.some((e) => e.type === 'BLIND_POSTED')).toBe(false);
    for (const p of h.state.players) {
      expect(p.currentBet).toBe(0);
      expect(p.totalInvested).toBe(25); // the bomb, as dead money
      expect(p.stack).toBe(975);
    }
    expect(h.state.collectedPot).toBe(75);
    expect(h.state.street).toBe(Street.Flop);
    expect(h.state.communityCards).toHaveLength(3);
    expect(totalPot(h.state)).toBe(75);
    expect(h.chips()).toBe(3000);
  });

  it('the first action is a flop action - there is no preflop betting node', () => {
    const h = new HandRunner(cfg(), seats([1000, 1000, 1000]));
    h.startHand(undefined, { amount: 10 });
    // 3-handed: button 0, and post-flop the first to act is the SB seat (1)
    expect(h.state.actingSeat).toBe(1);
    const ctx: BettingContext = {
      players: h.state.players,
      round: h.state.round,
      actingSeat: h.state.actingSeat!,
    };
    const kinds = legalActions(ctx, h.state.actingSeat!).map((o) => o.kind);
    // fresh flop round with no bet - the actor can check or bet, and there is
    // nothing to "call" (bomb money is dead, not a bet)
    expect(kinds).toContain('CHECK');
    expect(kinds).toContain('BET');
    expect(kinds).not.toContain('CALL');
  });

  it('the bomb amount is configurable (not tied to the big blind)', () => {
    const h = new HandRunner(cfg(), seats([1000, 1000]));
    h.startHand(undefined, { amount: 3 });
    for (const p of h.state.players) expect(p.totalInvested).toBe(3);
    expect(h.state.collectedPot).toBe(6);
  });

  it('rejects a bomb pot for a non-Hold’em variant', () => {
    const h = new HandRunner(cfg({ variant: GameVariant.Omaha }), seats([1000, 1000]));
    const res = h.startHand(undefined, { amount: 10 });
    expect(res.events).toEqual([
      expect.objectContaining({ type: 'ACTION_REJECTED', code: 'BOMB_POT_HOLDEM_ONLY' }),
    ]);
    expect(res.state.street).toBe(Street.Waiting);
  });

  it('rejects a non-positive bomb amount', () => {
    const h = new HandRunner(cfg(), seats([1000, 1000]));
    expect(h.startHand(undefined, { amount: 0 }).events[0]).toMatchObject({
      type: 'ACTION_REJECTED',
      code: 'BOMB_POT_AMOUNT',
    });
  });

  it('the dealer button still rotates across a bomb pot', () => {
    const h = new HandRunner(cfg(), seats([1000, 1000, 1000]));
    h.startHand(undefined, { amount: 10 });
    expect(h.state.buttonSeat).toBe(0);
    h.autoFinish(); // checks the board down
    expect(h.state.street).toBe(Street.Complete);
    h.startHand(); // normal next hand
    expect(h.state.buttonSeat).toBe(1); // moved
  });
});

describe('bomb pot - short stacks and side pots', () => {
  it('a player who cannot cover the bomb is all-in for their whole stack', () => {
    const h = new HandRunner(cfg(), seats([1000, 1000, 8]));
    h.startHand(undefined, { amount: 25 });
    const short = seatOf(h.state, 2);
    expect(short).toMatchObject({ stack: 0, currentBet: 0, totalInvested: 8 });
    expect(short.status).toBe(PlayerStatus.AllIn);
    expect(bombPosts(h.events).find((e) => e.seat === 2)?.amount).toBe(8);
    expect(h.chips()).toBe(2008);
  });

  it('a short bomb-only all-in wins a main pot that includes every bomb contribution', () => {
    const h = new HandRunner(cfg(), seats([8, 1000, 1000]));
    const order = h.nextDealOrder();
    h.startHand(
      buildDeck({
        order,
        holes: { 0: 'Ah As', 1: 'Kh Kd', 2: 'Qh Qd' },
        board: '2c 5d 9h Js 3c',
      }),
      { amount: 20 },
    );
    // seat 0 is all-in from the bomb; seats 1 & 2 play the flop down
    h.autoFinish();
    expect(h.state.street).toBe(Street.Complete);
    // main pot: 8 x 3 = 24 -> seat 0 (AA)
    expect(h.payoutOf(0)).toBe(24);
    // side pot: (20 - 8) x 2 = 24 -> seat 1 (KK)
    expect(h.payoutOf(1)).toBe(24);
    expect(h.stackOf(0)).toBe(24);
    expect(h.totalStacks()).toBe(2008);
  });

  it('three stack sizes all-in from the bomb build three pots', () => {
    const h = new HandRunner(cfg(), seats([8, 15, 50, 1000]));
    const order = h.nextDealOrder();
    h.startHand(
      buildDeck({
        order,
        holes: { 0: 'Ah As', 1: 'Kh Kd', 2: 'Qh Qd', 3: '7c 2d' },
        board: '3c 8s Tc Jd 4h',
      }),
      { amount: 20 },
    );
    h.autoFinish();
    expect(h.state.street).toBe(Street.Complete);
    // contributions 8 / 15 / 20 / 20 -> pots 8x4=32 (all), 7x3=21 ({1,2,3}),
    // 5x2=10 ({2,3})
    expect(h.payoutOf(0)).toBe(32); // AA
    expect(h.payoutOf(1)).toBe(21); // KK
    expect(h.payoutOf(2)).toBe(10); // QQ
    expect(h.payoutOf(3)).toBe(0);
    expect(h.totalStacks()).toBe(8 + 15 + 50 + 1000);
  });

  it("a folded player's bomb contribution stays in the pot as dead money", () => {
    const h = new HandRunner(cfg(), seats([1000, 1000, 1000]));
    const order = h.nextDealOrder();
    h.startHand(
      buildDeck({
        order,
        holes: { 0: '7c 2d', 1: 'Ah As', 2: 'Kh Kd' },
        board: '3c 8s Tc Jd 4h',
      }),
      { amount: 10 },
    );
    // seat 1 acts first on the flop (SB seat); it bets, seat 2 folds, seat 0 folds
    h.act(h.state.actingSeat!, { type: 'BET', amount: 20 });
    h.act(h.state.actingSeat!, fold());
    h.act(h.state.actingSeat!, fold());
    expect(h.state.street).toBe(Street.Complete);
    // seat 1 wins the three bombs (30) + its own returned bet
    expect(h.stackOf(0)).toBe(990); // lost exactly the bomb
    expect(h.stackOf(2)).toBe(990);
    expect(h.totalStacks()).toBe(3000);
  });

  it('heads-up bomb pot', () => {
    const h = new HandRunner(cfg(), seats([1000, 1000]));
    h.startHand(undefined, { amount: 40 });
    expect(bombPosts(h.events)).toHaveLength(2);
    expect(h.state.street).toBe(Street.Flop);
    for (const p of h.state.players) expect(p.totalInvested).toBe(40);
    // heads-up: post-flop the big blind (the non-button seat) acts first
    expect(h.state.actingSeat).not.toBe(h.state.buttonSeat);
    expect(h.chips()).toBe(2000);
  });

  it('a full 9-handed bomb pot', () => {
    const h = new HandRunner(cfg({ maxSeats: 9 }), seats(Array.from({ length: 9 }, () => 5000)));
    h.startHand(undefined, { amount: 50 });
    expect(bombPosts(h.events)).toHaveLength(9);
    expect(h.state.collectedPot).toBe(450);
    expect(h.state.street).toBe(Street.Flop);
    expect(h.chips()).toBe(45_000);
  });

  it('everyone all-in from the bomb runs the board out and settles', () => {
    const h = new HandRunner(cfg(), seats([30, 40, 20]));
    const order = h.nextDealOrder();
    h.startHand(
      buildDeck({ order, holes: { 0: 'Ah As', 1: 'Kh Kd', 2: 'Qh Qd' }, board: '2c 7d 9h Js 3s' }),
      { amount: 50 },
    );
    expect(h.state.actingSeat).toBeNull();
    expect(h.state.street).toBe(Street.Complete);
    expect(h.state.players.every((p) => p.status === PlayerStatus.AllIn)).toBe(true);
    expect(h.payoutOf(0)).toBe(80); // 20x3 + 10x2 (AA)
    expect(h.totalStacks()).toBe(90);
  });
});

describe('bomb pot - conservation, determinism, replay', () => {
  it('holds chip conservation after every flop/turn/river action', () => {
    const h = new HandRunner(cfg(), seats([600, 600, 600, 600]));
    h.startHand(undefined, { amount: 20 });
    let guard = 0;
    while (h.state.street !== Street.Complete && h.state.actingSeat !== null) {
      expect(h.chips()).toBe(2400);
      for (const p of h.state.players) expect(p.stack).toBeGreaterThanOrEqual(0);
      const owed = h.toCall(h.state.actingSeat!);
      h.act(h.state.actingSeat!, owed === 0 ? check() : call());
      if ((guard += 1) > 40) throw new Error('did not terminate');
    }
    expect(h.state.street).toBe(Street.Complete);
    expect(h.totalStacks()).toBe(2400);
    const completed = h.events.find(
      (e): e is Extract<GameEvent, { type: 'HAND_COMPLETED' }> => e.type === 'HAND_COMPLETED',
    )!;
    expect(completed.results.reduce((t, r) => t + r.net, 0)).toBe(0);
  });

  it('a bomb-pot hand replays bit-identically from its record', () => {
    const record: HandRecord = {
      tableId: 't',
      config: cfg(),
      seats: [
        { userId: 'u0', seatNumber: 0, stack: 500 },
        { userId: 'u1', seatNumber: 1, stack: 500 },
        { userId: 'u2', seatNumber: 2, stack: 500 },
      ],
      handId: 'b1',
      handNumber: 1,
      previousPositions: null,
      bombPot: { amount: 30 },
      deck: buildDeck({
        order: [1, 2, 0],
        holes: { 0: 'Ah As', 1: 'Kh Kd', 2: 'Qh Qd' },
        board: '2c 7d 9h Js 3s',
      }),
      actions: [
        { type: 'PLAYER_ACTION', seat: 1, action: { type: 'CHECK' } },
        { type: 'PLAYER_ACTION', seat: 2, action: { type: 'CHECK' } },
        { type: 'PLAYER_ACTION', seat: 0, action: { type: 'ALL_IN' } },
        { type: 'PLAYER_ACTION', seat: 1, action: { type: 'FOLD' } },
        { type: 'PLAYER_ACTION', seat: 2, action: { type: 'FOLD' } },
      ],
    };
    const a = replayHand(record);
    const b = replayHand(record);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
    expect(a.state.street).toBe(Street.Complete);
    expect(a.events.some((e) => e.type === 'BOMB_POT_STARTED')).toBe(true);
    expect(a.events.some((e) => e.type === 'BLIND_POSTED')).toBe(false);
    expect(a.state.players.reduce((t, p) => t + p.stack, 0)).toBe(1500);
  });

  it('the same deck without a bomb pot deals a different (preflop) hand', () => {
    const deck = buildDeck({
      order: [1, 2, 0],
      holes: { 0: 'Ah As', 1: 'Kh Kd', 2: 'Qh Qd' },
      board: '2c 7d 9h Js 3s',
    });
    const bomb = new HandRunner(cfg(), seats([500, 500, 500]));
    bomb.startHand(deck, { amount: 30 });
    const normal = new HandRunner(cfg(), seats([500, 500, 500]));
    normal.startHand(deck);
    expect(bomb.state.street).toBe(Street.Flop);
    expect(normal.state.street).toBe(Street.Preflop);
  });
});

// --- property / fuzz -----------------------------------------------------

describe('bomb pot - fuzz', () => {
  it('thousands of bomb-pot hands: conservation, no negatives, no card dup, cadence intact', () => {
    // mulberry32 - deterministic, no Math.random / second RNG in the harness
    let s = 0x50f7 >>> 0;
    const rnd = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const nextInt = (n: number) => Math.floor(rnd() * n);

    let hands = 0;
    let bombs = 0;
    for (let game = 0; game < 400; game += 1) {
      const count = 2 + nextInt(5);
      const stacks = Array.from({ length: count }, () => 1 + nextInt(nextInt(9) === 0 ? 60 : 800));
      const total = stacks.reduce((a, b) => a + b, 0);
      const h = new HandRunner(cfg(), seats(stacks));
      const interval = 3;
      let sinceBomb = 0;
      for (let hand = 1; hand <= 6; hand += 1) {
        if (h.state.players.filter((p) => p.stack > 0).length < 2) break;
        const isBomb = sinceBomb + 1 >= interval;
        const startEvents = h.startHand(
          undefined,
          isBomb ? { amount: 5 + nextInt(20) } : undefined,
        ).events;
        if (isBomb && h.state.street !== Street.Waiting) {
          bombs += 1;
          // a bomb hand is on the flop with 3 board cards, or already complete
          expect(h.state.communityCards.length).toBeGreaterThanOrEqual(3);
          expect(startEvents.some((e) => e.type === 'BLIND_POSTED')).toBe(false);
          expect(startEvents.some((e) => e.type === 'BOMB_POT_STARTED')).toBe(true);
        } else if (!isBomb && h.state.street !== Street.Waiting) {
          expect(startEvents.some((e) => e.type === 'BOMB_POT_STARTED')).toBe(false);
          expect(startEvents.some((e) => e.type === 'BOMB_POT_POSTED')).toBe(false);
        }

        let guard = 0;
        while (h.state.street !== Street.Complete && h.state.actingSeat !== null) {
          expect(h.chips()).toBe(total);
          for (const p of h.state.players) expect(p.stack).toBeGreaterThanOrEqual(0);
          // no duplicated cards anywhere in play
          const inPlay = [
            ...h.state.communityCards,
            ...h.state.players.flatMap((p) => p.holeCards),
          ];
          expect(new Set(inPlay.map((c) => `${c.rank}${c.suit}`)).size).toBe(inPlay.length);
          const seat = h.state.actingSeat!;
          const owed = h.toCall(seat);
          const roll = rnd();
          const act =
            roll < 0.15 ? fold() : roll < 0.85 ? (owed === 0 ? check() : call()) : allIn();
          const res = h.act(seat, act);
          expect(res.events.some((e) => e.type === 'ACTION_REJECTED')).toBe(false);
          if ((guard += 1) > 200) throw new Error('hand did not terminate');
        }
        if (h.state.street === Street.Complete) {
          expect(h.totalStacks()).toBe(total);
          sinceBomb = isBomb ? 0 : sinceBomb + 1;
          hands += 1;
        } else {
          break;
        }
      }
    }
    expect(hands).toBeGreaterThan(800);
    expect(bombs).toBeGreaterThan(200);
  });
});
