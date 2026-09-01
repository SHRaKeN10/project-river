import { betTo, call, check, fold, raiseTo } from '../betting';
import { Street } from '../game-state/game-state';
import { createTableConfig } from '../table/table';
import { buildDeck } from '../testkit/deckBuilder';
import { HandRunner, type Seat } from '../testkit/handRunner';
import { type EngineAction } from './reduce';

const config = createTableConfig({ smallBlind: 5, bigBlind: 10 });
const seats = (n: number, stack = 1000): Seat[] =>
  Array.from({ length: n }, (_, i) => ({ userId: `u${i}`, seatNumber: i, stack }));

function threeHandedMidBet(): HandRunner {
  const h = new HandRunner(config, seats(3));
  const order = h.nextDealOrder();
  h.startHand(
    buildDeck({
      order,
      holes: { [order[0]!]: '2c 7d', [order[1]!]: '3c 8d', [order[2]!]: '4c 9d' },
      board: 'Ks Qs 9h 4d 3s',
    }),
  );
  return h;
}

/** Every rejection must leave state byte-identical and emit exactly one event. */
function expectRejected(h: HandRunner, action: EngineAction): void {
  const before = JSON.stringify(h.state);
  const res = h.dispatch(action);
  expect(res.events).toHaveLength(1);
  expect(res.events[0]?.type).toBe('ACTION_REJECTED');
  expect(JSON.stringify(res.state)).toBe(before);
}

describe('invalid actions are rejected without touching state', () => {
  it('acting out of turn', () => {
    const h = threeHandedMidBet();
    const notTurn = h.state.players.find((p) => p.seatNumber !== h.state.actingSeat)!.seatNumber;
    expectRejected(h, { type: 'PLAYER_ACTION', seat: notTurn, action: fold() });
  });

  it('checking when facing a bet', () => {
    const h = threeHandedMidBet();
    h.act(h.state.actingSeat!, raiseTo(40));
    expectRejected(h, { type: 'PLAYER_ACTION', seat: h.state.actingSeat!, action: check() });
  });

  it('calling when nothing is owed (flop, no bet)', () => {
    const h = threeHandedMidBet();
    h.act(h.state.actingSeat!, call());
    h.act(h.state.actingSeat!, call());
    h.act(h.state.actingSeat!, check());
    expect(h.state.street).toBe(Street.Flop);
    expectRejected(h, { type: 'PLAYER_ACTION', seat: h.state.actingSeat!, action: call() });
  });

  it('betting pre-flop (there is already the big blind - must raise)', () => {
    const h = threeHandedMidBet();
    expectRejected(h, { type: 'PLAYER_ACTION', seat: h.state.actingSeat!, action: betTo(40) });
  });

  it('raising below the minimum', () => {
    const h = threeHandedMidBet();
    // pre-flop currentBet is the BB (10); the minimum raise is to 20
    expectRejected(h, { type: 'PLAYER_ACTION', seat: h.state.actingSeat!, action: raiseTo(15) });
  });

  it('raising more than the stack', () => {
    const h = threeHandedMidBet();
    expectRejected(h, { type: 'PLAYER_ACTION', seat: h.state.actingSeat!, action: raiseTo(5000) });
  });

  it('non-integer and negative amounts', () => {
    const h = threeHandedMidBet();
    const seat = h.state.actingSeat!;
    expectRejected(h, { type: 'PLAYER_ACTION', seat, action: raiseTo(30.5) });
    expectRejected(h, { type: 'PLAYER_ACTION', seat, action: raiseTo(-100) });
    expectRejected(h, { type: 'PLAYER_ACTION', seat, action: betTo(-1) });
  });

  it('acting after folding', () => {
    const h = threeHandedMidBet();
    const folder = h.state.actingSeat!;
    h.act(folder, fold());
    expectRejected(h, { type: 'PLAYER_ACTION', seat: folder, action: call() });
  });

  it('acting after going all-in', () => {
    const h = new HandRunner(config, [
      { userId: 'a', seatNumber: 0, stack: 40 },
      { userId: 'b', seatNumber: 1, stack: 1000 },
      { userId: 'c', seatNumber: 2, stack: 1000 },
    ]);
    const order = h.nextDealOrder();
    h.startHand(
      buildDeck({
        order,
        holes: { [order[0]!]: '2c 7d', [order[1]!]: '3c 8d', [order[2]!]: '4c 9d' },
        board: 'Ks Qs 9h 4d 3s',
      }),
    );
    h.act(h.state.actingSeat!, { type: 'ALL_IN' }); // seat 0 all-in for 40
    expectRejected(h, { type: 'PLAYER_ACTION', seat: 0, action: call() });
  });

  it('acting when no hand is in progress', () => {
    const h = new HandRunner(config, seats(2));
    expect(h.state.street).toBe(Street.Waiting);
    expectRejected(h, { type: 'PLAYER_ACTION', seat: 0, action: check() });
  });

  it('acting after the hand has completed', () => {
    const h = threeHandedMidBet();
    h.act(h.state.actingSeat!, raiseTo(30));
    h.act(h.state.actingSeat!, fold());
    h.act(h.state.actingSeat!, fold());
    expect(h.state.street).toBe(Street.Complete);
    expectRejected(h, { type: 'PLAYER_ACTION', seat: 0, action: check() });
  });

  it('starting a hand while one is already running', () => {
    const h = threeHandedMidBet();
    expectRejected(h, {
      type: 'START_HAND',
      handId: 'x',
      handNumber: 9,
      previousPositions: null,
    });
  });

  it('a stale duplicate raise is rejected once the bet has moved on', () => {
    const h = threeHandedMidBet();
    h.act(h.state.actingSeat!, raiseTo(40));
    h.act(h.state.actingSeat!, call());
    // seat that already acted tries to raise to the old target
    expectRejected(h, { type: 'PLAYER_ACTION', seat: 0, action: raiseTo(40) });
  });
});
