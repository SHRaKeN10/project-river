import { call, check, fold, raiseTo, type BettingContext } from '../betting';
import { legalActions } from '../action-validator';
import { type GameEvent } from '../events/events';
import { type GameState, Street } from '../game-state/game-state';
import { PlayerStatus } from '../player/player';
import { createTableConfig } from '../table/table';
import { buildDeck } from '../testkit/deckBuilder';
import { HandRunner, type Seat } from '../testkit/handRunner';
import { replayHand, type HandRecord } from './replay';

/**
 * Voluntary UTG straddle for NLHE cash. A straddle is "a second, bigger big
 * blind one seat along": the blinds are posted as normal, then the UTG seat
 * posts `amount` (>= 2x BB) as a live blind-raise. Pre-flop action starts at the
 * seat after the straddle and the straddle keeps the option (acts last, may
 * re-raise). Never combined with a bomb pot; needs 3+ dealt-in seats.
 */

const cfg = (over = {}) => createTableConfig({ smallBlind: 5, bigBlind: 10, ...over });
const seats = (stacks: number[]): Seat[] =>
  stacks.map((stack, i) => ({ userId: `u${i}`, seatNumber: i, stack }));
const types = (events: GameEvent[]): string[] => events.map((e) => e.type);
const seatOf = (s: GameState, seat: number) => s.players.find((p) => p.seatNumber === seat)!;
const ctx = (s: GameState): BettingContext => ({
  players: s.players,
  round: s.round,
  actingSeat: s.actingSeat as number,
  potBeforeRound: s.collectedPot,
});
const straddlePosts = (events: GameEvent[]) =>
  events.filter(
    (e): e is Extract<GameEvent, { type: 'STRADDLE_POSTED' }> => e.type === 'STRADDLE_POSTED',
  );

describe('straddle - posting and pre-flop flow', () => {
  it('a normal (non-straddled) hand is completely unchanged', () => {
    const h = new HandRunner(cfg(), seats([1000, 1000, 1000]));
    h.startHand();
    expect(types(h.events)).toEqual([
      'HAND_STARTED',
      'BLIND_POSTED',
      'BLIND_POSTED',
      'HOLE_CARDS_DEALT',
    ]);
    expect(straddlePosts(h.events)).toHaveLength(0);
  });

  it('posts the blinds AND the straddle, then acts from the seat after the straddle', () => {
    // 3-handed: button/UTG = 0, SB = 1, BB = 2
    const h = new HandRunner(cfg(), seats([1000, 1000, 1000]));
    const utg = h.nextPositions().firstToActPreflop;
    expect(utg).toBe(0);

    const start = h.startHand(undefined, { straddle: { seat: utg, amount: 20 } });
    expect(types(start.events)).toEqual([
      'HAND_STARTED',
      'BLIND_POSTED', // SB 5
      'BLIND_POSTED', // BB 10
      'STRADDLE_POSTED', // seat 0, 20
      'HOLE_CARDS_DEALT',
    ]);
    const posted = straddlePosts(start.events)[0]!;
    expect(posted).toMatchObject({ seat: 0, amount: 20 });

    expect(h.state.round.currentBet).toBe(20);
    expect(h.state.round.lastRaiseSize).toBe(10); // 20 - 10
    expect(h.state.round.lastAggressorSeat).toBe(0);

    expect(seatOf(h.state, 0).currentBet).toBe(20);
    expect(seatOf(h.state, 0).stack).toBe(980);
    expect(seatOf(h.state, 1).currentBet).toBe(5);
    expect(seatOf(h.state, 2).currentBet).toBe(10);

    // SB (seat 1) acts first pre-flop, not UTG
    expect(h.state.actingSeat).toBe(1);
  });

  it('the straddle keeps the option: it acts last and may check to close or raise to re-open', () => {
    const h = new HandRunner(cfg(), seats([1000, 1000, 1000]));
    h.startHand(undefined, { straddle: { seat: 0, amount: 20 } });

    h.act(1, call()); // SB completes to 20
    h.act(2, call()); // BB calls to 20
    expect(h.state.actingSeat).toBe(0); // back to the straddle for the option
    expect(h.state.street).toBe(Street.Preflop); // NOT complete yet - option pending

    const opts = legalActions(ctx(h.state), 0).map((o) => o.kind);
    expect(opts).toEqual(expect.arrayContaining(['CHECK', 'RAISE']));
    expect(opts).not.toContain('CALL');

    h.act(0, check()); // straddle checks its option -> pre-flop closes
    expect(h.state.street).toBe(Street.Flop);
  });

  it('the straddle exercising its option re-opens the betting', () => {
    const h = new HandRunner(cfg(), seats([1000, 1000, 1000]));
    h.startHand(undefined, { straddle: { seat: 0, amount: 20 } });
    h.act(1, call());
    h.act(2, call());
    h.act(0, raiseTo(50)); // straddle raises its option
    expect(h.state.street).toBe(Street.Preflop);
    expect(h.state.round.currentBet).toBe(50);
    // action re-opens: SB and BB must act again
    expect([1, 2]).toContain(h.state.actingSeat);
  });

  it('6-handed: the straddle is UTG (seat after BB) and first action is UTG+1', () => {
    const h = new HandRunner(cfg(), seats([1000, 1000, 1000, 1000, 1000, 1000]));
    const p = h.nextPositions();
    // button 0, SB 1, BB 2, UTG 3
    expect(p.firstToActPreflop).toBe(3);
    h.startHand(undefined, { straddle: { seat: 3, amount: 20 } });
    expect(h.state.actingSeat).toBe(4); // UTG+1
    expect(seatOf(h.state, 3).currentBet).toBe(20);
  });

  it('button/blind rotation is unaffected by a straddle', () => {
    const h = new HandRunner(cfg(), seats([1000, 1000, 1000]));
    h.startHand(undefined, { straddle: { seat: 0, amount: 20 } });
    h.autoFinish();
    expect(h.state.street).toBe(Street.Complete);
    const before = { button: h.state.buttonSeat, bb: h.state.bigBlindSeat };
    h.startHand(); // next hand, no straddle
    expect(h.state.bigBlindSeat).toBe((before.bb + 1) % 3 === 0 ? 0 : before.bb + 1);
    expect(h.state.buttonSeat).not.toBe(before.button);
  });
});

describe('straddle - short stacks and all-in', () => {
  it('a straddler with exactly the straddle amount is all-in and has no option', () => {
    const h = new HandRunner(cfg(), seats([20, 1000, 1000]));
    h.startHand(undefined, { straddle: { seat: 0, amount: 20 } });
    expect(seatOf(h.state, 0).status).toBe(PlayerStatus.AllIn);
    expect(h.state.round.currentBet).toBe(20);

    h.act(1, call());
    h.act(2, call());
    // no option for the all-in straddle - pre-flop closes straight to the flop
    expect(h.state.street).toBe(Street.Flop);
  });

  it('a straddler who cannot cover a full raise posts all-in and does not grow the min raise', () => {
    // bb 10, straddle "to 20" but the seat only has 15
    const h = new HandRunner(cfg(), seats([15, 1000, 1000]));
    h.startHand(undefined, { straddle: { seat: 0, amount: 20 } });
    expect(seatOf(h.state, 0).stack).toBe(0);
    expect(seatOf(h.state, 0).status).toBe(PlayerStatus.AllIn);
    expect(h.state.round.currentBet).toBe(15); // max(bb, 15)
    expect(h.state.round.lastRaiseSize).toBe(10); // 15-10 = 5 is incomplete -> unchanged

    // the next player's minimum raise is still to currentBet + lastRaiseSize = 25
    const raise = legalActions(ctx(h.state), 1).find((o) => o.kind === 'RAISE');
    expect(raise?.min).toBe(25);
  });

  it('conserves chips through a straddled hand played to showdown', () => {
    const h = new HandRunner(cfg(), seats([300, 300, 300, 300]));
    const before = h.totalStacks();
    h.startHand(undefined, { straddle: { seat: h.nextPositions().firstToActPreflop, amount: 20 } });
    let guard = 0;
    while (h.state.street !== Street.Complete && (guard += 1) < 60) {
      const seat = h.state.actingSeat;
      if (seat === null) break;
      h.act(seat, h.toCall(seat) === 0 ? check() : call());
      expect(h.chips()).toBe(before);
    }
    expect(h.state.street).toBe(Street.Complete);
    expect(h.totalStacks()).toBe(before);
  });
});

describe('straddle - rejections', () => {
  const rej = (r: { events: GameEvent[] }) =>
    r.events.find(
      (e): e is Extract<GameEvent, { type: 'ACTION_REJECTED' }> => e.type === 'ACTION_REJECTED',
    );

  it('rejects a straddle combined with a bomb pot', () => {
    const h = new HandRunner(cfg(), seats([1000, 1000, 1000]));
    const r = h.startHand(undefined, {
      bombPot: { amount: 20 },
      straddle: { seat: 0, amount: 20 },
    });
    expect(rej(r)?.code).toBe('STRADDLE_ON_BOMB_POT');
    expect(h.state.street).toBe(Street.Waiting);
  });

  it('rejects a straddle under twice the big blind', () => {
    const h = new HandRunner(cfg(), seats([1000, 1000, 1000]));
    expect(rej(h.startHand(undefined, { straddle: { seat: 0, amount: 15 } }))?.code).toBe(
      'STRADDLE_AMOUNT',
    );
    expect(rej(h.startHand(undefined, { straddle: { seat: 0, amount: 20.5 } }))?.code).toBe(
      'STRADDLE_AMOUNT',
    );
  });

  it('rejects a straddle heads-up (fewer than three players)', () => {
    const h = new HandRunner(cfg(), seats([1000, 1000]));
    expect(rej(h.startHand(undefined, { straddle: { seat: 0, amount: 20 } }))?.code).toBe(
      'STRADDLE_MIN_PLAYERS',
    );
  });

  it('rejects a straddle from a seat that is not under the gun', () => {
    const h = new HandRunner(cfg(), seats([1000, 1000, 1000]));
    // UTG is seat 0; seat 1 is the SB
    expect(rej(h.startHand(undefined, { straddle: { seat: 1, amount: 20 } }))?.code).toBe(
      'STRADDLE_SEAT',
    );
  });
});

describe('straddle - replay', () => {
  it('a straddled hand replays bit-identically', () => {
    const h = new HandRunner(cfg(), seats([500, 500, 500]));
    const order = h.nextDealOrder();
    const deck = buildDeck({
      order,
      holes: { 0: 'Ah As', 1: 'Kh Kd', 2: 'Qh Qd' },
      board: '2c 7d 9h Js 3s',
    });
    h.startHand(deck, { straddle: { seat: 0, amount: 20 } });
    h.autoFinish();
    const live = types(h.events);

    const record: HandRecord = {
      tableId: 'test',
      config: cfg(),
      seats: [
        { userId: 'u0', seatNumber: 0, stack: 500 },
        { userId: 'u1', seatNumber: 1, stack: 500 },
        { userId: 'u2', seatNumber: 2, stack: 500 },
      ],
      handId: 'h1',
      handNumber: 1,
      previousPositions: null,
      straddle: { seat: 0, amount: 20 },
      deck,
      actions: h.actionsThisHand,
    };
    const replayed = replayHand(record);
    expect(types(replayed.events)).toEqual(live);
    expect(replayed.state.players.map((p) => p.stack)).toEqual(h.state.players.map((p) => p.stack));
  });
});

describe('straddle - fuzz', () => {
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('~1500 random straddled hands: conservation, no negatives, no card reuse', () => {
    const rand = mulberry32(9182);
    const nextInt = (n: number) => Math.floor(rand() * n);
    const stacks = [1200, 1200, 1200, 1200, 1200];
    const h = new HandRunner(cfg(), seats(stacks));
    const startChips = stacks.reduce((a, b) => a + b, 0);
    let straddled = 0;

    for (let hand = 0; hand < 1500; hand += 1) {
      if (h.state.players.filter((p) => p.stack > 0).length < 3) break;
      const utg = h.nextPositions().firstToActPreflop;
      const utgStack = seatOf(h.state, utg).stack;
      const doStraddle = rand() < 0.6 && utgStack >= 20;
      const start = doStraddle
        ? h.startHand(undefined, { straddle: { seat: utg, amount: 20 } })
        : h.startHand();
      if (
        doStraddle &&
        h.state.handId === start.state.handId &&
        h.state.street !== Street.Waiting
      ) {
        straddled += 1;
        expect(types(start.events)).toContain('STRADDLE_POSTED');
      }

      let guard = 0;
      while (h.state.street !== Street.Complete && h.state.actingSeat !== null) {
        if ((guard += 1) > 120) throw new Error('hand did not terminate');
        const seat = h.state.actingSeat;
        const owed = h.toCall(seat);
        const roll = rand();
        if (owed === 0) {
          h.act(seat, roll < 0.8 ? check() : raiseTo(h.state.round.currentBet + 20 + nextInt(40)));
        } else if (roll < 0.6) {
          h.act(seat, call());
        } else if (roll < 0.85) {
          h.act(seat, fold());
        } else {
          const to = h.state.round.currentBet + h.state.round.lastRaiseSize + nextInt(60);
          h.act(seat, raiseTo(to));
        }
        expect(h.chips()).toBe(startChips);
        for (const p of h.state.players) expect(p.stack).toBeGreaterThanOrEqual(0);
      }

      const dealt = h.state.players.flatMap((p) => p.holeCards);
      const board = h.state.communityCards;
      const all = [...dealt, ...board].map((c) => `${c.rank}${c.suit}`);
      expect(new Set(all).size).toBe(all.length);
      expect(h.totalStacks()).toBe(startChips);
    }

    expect(straddled).toBeGreaterThan(200);
  });
});
