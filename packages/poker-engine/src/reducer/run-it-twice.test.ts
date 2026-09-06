import { allIn, call, check, fold } from '../betting';
import { cardToString } from '../cards';
import { type GameEvent } from '../events/events';
import { Street } from '../game-state/game-state';
import { PlayerStatus } from '../player/player';
import { createTableConfig } from '../table/table';
import { buildDeck } from '../testkit/deckBuilder';
import { HandRunner, type Seat } from '../testkit/handRunner';
import { replayHand, type HandRecord } from './replay';

/**
 * Run It Twice (ADR-0028). When an all-in run-out happens with cards still to
 * come and 2+ players contesting, `START_HAND { runItTwice: true }` makes the
 * engine deal two boards from the same deck and award each board half of every
 * pot (odd chip to the first board). Reuses `buildPots` / `evaluateShowdown` /
 * `awardPots` unchanged; Hold'em high only.
 */

const cfg = (over = {}) => createTableConfig({ smallBlind: 5, bigBlind: 10, ...over });
const seats = (stacks: number[]): Seat[] =>
  stacks.map((stack, i) => ({ userId: `u${i}`, seatNumber: i, stack }));
const types = (events: GameEvent[]): string[] => events.map((e) => e.type);
const awards = (events: GameEvent[]) =>
  events.filter((e): e is Extract<GameEvent, { type: 'POT_AWARDED' }> => e.type === 'POT_AWARDED');
const totalAwarded = (events: GameEvent[]) =>
  awards(events).reduce((t, a) => t + a.winners.reduce((s, w) => s + w.amount, 0), 0);
const secondBoard = (events: GameEvent[]) =>
  events.find(
    (e): e is Extract<GameEvent, { type: 'SECOND_BOARD_DEALT' }> => e.type === 'SECOND_BOARD_DEALT',
  );

/** Every physical card is used once: the two boards may legitimately share the
 * cards dealt before the all-in; only the divergent suffixes and the hole cards
 * must all be distinct. */
function assertNoCardReuse(h: HandRunner): void {
  const b1 = h.state.communityCards.map(cardToString);
  const b2 = h.state.secondBoard.map(cardToString);
  let shared = 0;
  while (shared < b1.length && b1[shared] === b2[shared]) shared += 1;
  const physical = [
    ...h.state.players.flatMap((p) => p.holeCards.map(cardToString)),
    ...b1,
    ...b2.slice(shared),
  ];
  expect(new Set(physical).size).toBe(physical.length);
}

/** Drive the current hand to completion with everyone shoving all-in. */
function shoveAll(h: HandRunner): void {
  let guard = 0;
  while (h.state.street !== Street.Complete && h.state.actingSeat !== null) {
    if ((guard += 1) > 40) throw new Error('did not terminate');
    const seat = h.state.actingSeat;
    if (h.stackOf(seat) > 0) h.act(seat, allIn());
    else h.act(seat, h.toCall(seat) > 0 ? call() : check());
  }
}

describe('run it twice - two boards', () => {
  it('a hand without runItTwice runs a single board (unchanged)', () => {
    const h = new HandRunner(cfg(), seats([200, 200]));
    h.startHand();
    h.act(h.state.actingSeat!, allIn());
    h.act(h.state.actingSeat!, call());
    expect(h.state.street).toBe(Street.Complete);
    expect(h.state.secondBoard).toEqual([]);
    expect(secondBoard(h.events)).toBeUndefined();
    expect(h.state.communityCards).toHaveLength(5);
  });

  it('heads-up all-in: deals two full independent boards and splits the pot', () => {
    const h = new HandRunner(cfg(), seats([200, 200]));
    const pot = 400;
    h.startHand(undefined, { runItTwice: true });
    h.act(h.state.actingSeat!, allIn());
    h.act(h.state.actingSeat!, call());

    expect(h.state.street).toBe(Street.Complete);
    expect(h.state.communityCards).toHaveLength(5);
    expect(h.state.secondBoard).toHaveLength(5);

    const sb = secondBoard(h.events)!;
    expect(sb.cards).toHaveLength(5);
    // preflop all-in -> two fully independent boards, no shared cards
    expect(h.state.communityCards.map(cardToString)).not.toEqual(
      h.state.secondBoard.map(cardToString),
    );
    assertNoCardReuse(h);

    // one MAIN award per board, each for half the pot
    const potAwards = awards(h.events);
    expect(potAwards.filter((a) => a.board === 1)).toHaveLength(1);
    expect(potAwards.filter((a) => a.board === 2)).toHaveLength(1);
    expect(potAwards.find((a) => a.board === 1)!.amount).toBe(pot / 2);
    expect(potAwards.find((a) => a.board === 2)!.amount).toBe(pot / 2);
    expect(totalAwarded(h.events)).toBe(pot);
    expect(h.totalStacks()).toBe(400);
  });

  it('an odd main pot gives the extra chip to the first board', () => {
    // seats 0:33  1:100  2:100 ; everyone all-in -> main pot 33*3 = 99 (odd)
    const h = new HandRunner(cfg(), seats([33, 100, 100]));
    h.startHand(undefined, { runItTwice: true });
    shoveAll(h);
    const main = h.state.pots.find(() => true)!;
    expect(main.amount).toBe(99);
    const mainAwards = awards(h.events).filter((a) => a.potType === 'MAIN');
    expect(mainAwards.find((a) => a.board === 1)!.amount).toBe(50); // ceil(99/2)
    expect(mainAwards.find((a) => a.board === 2)!.amount).toBe(49); // floor
    expect(totalAwarded(h.events)).toBe(h.state.pots.reduce((t, p) => t + p.amount, 0));
    expect(h.totalStacks()).toBe(233);
  });

  it('multiway all-in with unequal stacks: main + side pot, each halved per board', () => {
    // seats 0:60  1:150  2:150 ; blinds 5/10. Everyone all-in.
    const h = new HandRunner(cfg(), seats([60, 150, 150]));
    h.startHand(undefined, { runItTwice: true });
    // drive everyone all-in
    shoveAll(h);
    expect(h.state.street).toBe(Street.Complete);
    expect(h.state.secondBoard).toHaveLength(5);

    // pots: main = 60*3 = 180 ; side = 90*2 = 180 ; total 360
    const potTotal = h.state.pots.reduce((t, p) => t + p.amount, 0);
    expect(potTotal).toBe(360);

    const potAwards = awards(h.events);
    // 2 pots x 2 boards = up to 4 awards; total conserved
    expect(totalAwarded(h.events)).toBe(360);
    expect(h.totalStacks()).toBe(360);
    // seat 0 is not eligible for the side pot on either board
    for (const a of potAwards) {
      if (a.potType === 'SIDE') expect(a.winners.every((w) => w.seat !== 0)).toBe(true);
    }
  });

  it('a folded player is in neither board (their chips are still in the pot)', () => {
    const h = new HandRunner(cfg(), seats([200, 200, 200]));
    h.startHand(undefined, { runItTwice: true });
    // seat that acts first folds, the other two get all-in
    h.act(h.state.actingSeat!, fold());
    shoveAll(h);
    expect(h.state.street).toBe(Street.Complete);
    for (const a of awards(h.events)) {
      expect(
        a.winners.every(
          (w) =>
            w.seat !== h.state.players.find((p) => p.status === PlayerStatus.Folded)!.seatNumber,
        ),
      ).toBe(true);
    }
    expect(h.totalStacks()).toBe(600);
  });

  it('all-in on the turn: one river dealt per board, flop+turn shared', () => {
    const h = new HandRunner(cfg(), seats([300, 300]));
    const deck = buildDeck({
      order: h.nextDealOrder(),
      holes: { 0: 'Ah Kh', 1: '2c 7d' },
      board: 'Qh Jh Th 3s 4s',
    });
    h.startHand(deck, { runItTwice: true });
    // preflop: call, call to see a flop
    h.act(h.state.actingSeat!, call());
    h.act(h.state.actingSeat!, check());
    // flop: check, check
    h.act(h.state.actingSeat!, check());
    h.act(h.state.actingSeat!, check());
    // turn: shove and call
    h.act(h.state.actingSeat!, allIn());
    h.act(h.state.actingSeat!, call());

    expect(h.state.street).toBe(Street.Complete);
    // both boards share the flop + turn, differ only on the river
    expect(h.state.communityCards.slice(0, 4).map(cardToString)).toEqual(
      h.state.secondBoard.slice(0, 4).map(cardToString),
    );
    expect(cardToString(h.state.communityCards[4]!)).not.toEqual(
      cardToString(h.state.secondBoard[4]!),
    );
    // seat 0 made a royal on the turn - wins both boards, so the whole pot
    expect(h.payoutOf(0)).toBe(600);
    expect(h.totalStacks()).toBe(600);
  });

  it('four stack sizes: main + two side pots, every pot halved on both boards', () => {
    const h = new HandRunner(cfg(), seats([40, 90, 160, 300]));
    h.startHand(undefined, { runItTwice: true });
    shoveAll(h);
    expect(h.state.street).toBe(Street.Complete);
    // 3 distinct all-in amounts among 4 players -> main + 2 side pots
    expect(h.state.pots.length).toBeGreaterThanOrEqual(3);
    const potTotal = h.state.pots.reduce((t, p) => t + p.amount, 0);
    expect(totalAwarded(h.events)).toBe(potTotal);
    expect(h.totalStacks()).toBe(40 + 90 + 160 + 300);
    // every pot produced an award for board 1 and board 2
    for (let i = 0; i < h.state.pots.length; i += 1) {
      const forPot = awards(h.events).filter((a) => a.potIndex === i);
      expect(forPot.some((a) => a.board === 1)).toBe(true);
      expect(forPot.some((a) => a.board === 2)).toBe(true);
    }
  });

  it('composes with a bomb pot: an all-in bomb hand can still run twice', () => {
    const h = new HandRunner(cfg(), seats([25, 25, 200]));
    // bomb amount 30 -> seats 0 & 1 all-in from the bomb, seat 2 covers and has
    // chips behind, so it opens on the flop with seat 2 to act
    h.startHand(undefined, { bombPot: { amount: 30 }, runItTwice: true });
    expect(h.state.street).toBe(Street.Flop);
    h.act(h.state.actingSeat!, check()); // seat 2 checks -> all-in run-out, two boards
    expect(h.state.street).toBe(Street.Complete);
    expect(h.state.secondBoard).toHaveLength(5);
    expect(totalAwarded(h.events)).toBe(h.state.pots.reduce((t, p) => t + p.amount, 0));
    expect(h.totalStacks()).toBe(250);
  });

  it('replays bit-identically', () => {
    const h = new HandRunner(cfg(), seats([200, 200, 200]));
    const order = h.nextDealOrder();
    const deck = buildDeck({
      order,
      holes: { 0: 'Ah As', 1: 'Kh Kd', 2: 'Qh Qd' },
      board: '2c 7d 9h Js 3s',
    });
    h.startHand(deck, { runItTwice: true });
    shoveAll(h);
    const live = types(h.events);

    const record: HandRecord = {
      tableId: 'test',
      config: cfg(),
      seats: [
        { userId: 'u0', seatNumber: 0, stack: 200 },
        { userId: 'u1', seatNumber: 1, stack: 200 },
        { userId: 'u2', seatNumber: 2, stack: 200 },
      ],
      handId: 'h1',
      handNumber: 1,
      previousPositions: null,
      runItTwice: true,
      deck,
      actions: h.actionsThisHand,
    };
    const r = replayHand(record);
    expect(types(r.events)).toEqual(live);
    expect(r.state.communityCards.map(cardToString)).toEqual(
      h.state.communityCards.map(cardToString),
    );
    expect(r.state.secondBoard.map(cardToString)).toEqual(h.state.secondBoard.map(cardToString));
    expect(r.state.players.map((p) => p.stack)).toEqual(h.state.players.map((p) => p.stack));
  });
});

describe('run it twice - fuzz', () => {
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

  it('~800 random all-in hands run twice: conservation, no negatives, no card reuse', () => {
    const rand = mulberry32(4242);
    const nextInt = (n: number) => Math.floor(rand() * n);
    let ranTwice = 0;

    for (let hand = 0; hand < 800; hand += 1) {
      const n = 2 + nextInt(4); // 2..5 players
      const stacks = Array.from({ length: n }, () => 80 + nextInt(400));
      const h = new HandRunner(cfg(), seats(stacks));
      const startChips = stacks.reduce((a, b) => a + b, 0);
      h.startHand(undefined, { runItTwice: true });

      let guard = 0;
      while (h.state.street !== Street.Complete && h.state.actingSeat !== null) {
        if ((guard += 1) > 80) throw new Error('did not terminate');
        const seat = h.state.actingSeat;
        const owed = h.toCall(seat);
        const roll = rand();
        // heavy all-in bias so a run-out actually happens
        if (h.stackOf(seat) > 0 && roll < 0.65) h.act(seat, allIn());
        else if (owed === 0) h.act(seat, check());
        else if (roll < 0.92) h.act(seat, call());
        else h.act(seat, fold());
        expect(h.chips()).toBe(startChips);
        for (const p of h.state.players) expect(p.stack).toBeGreaterThanOrEqual(0);
      }

      if (h.state.secondBoard.length > 0) {
        ranTwice += 1;
        expect(h.state.secondBoard).toHaveLength(5);
        assertNoCardReuse(h);
      }
      expect(h.totalStacks()).toBe(startChips);
    }

    expect(ranTwice).toBeGreaterThan(150);
  });
});
