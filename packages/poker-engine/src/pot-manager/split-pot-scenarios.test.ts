import { allIn, call, fold } from '../betting';
import { Street } from '../game-state/game-state';
import { createTableConfig } from '../table/table';
import { buildDeck } from '../testkit/deckBuilder';
import { HandRunner, type Seat } from '../testkit/handRunner';

const config = createTableConfig({ smallBlind: 5, bigBlind: 10 });
const seats = (stacks: number[]): Seat[] =>
  stacks.map((stack, i) => ({ userId: `u${i}`, seatNumber: i, stack }));

describe('split pots through the full reducer', () => {
  it('heads-up: both play the board, the pot splits evenly', () => {
    const h = new HandRunner(config, seats([600, 600]));
    const order = h.nextDealOrder();
    h.startHand(
      buildDeck({
        order,
        holes: { 0: '2c 3d', 1: '2h 4s' },
        board: 'As Ks Qd Jd Th', // broadway on the board - both play it
      }),
    );
    h.act(h.state.actingSeat!, allIn());
    h.act(h.state.actingSeat!, call());
    h.autoFinish();

    expect(h.state.street).toBe(Street.Complete);
    expect(h.payoutOf(0)).toBe(600);
    expect(h.payoutOf(1)).toBe(600);
    expect(h.stackOf(0)).toBe(600);
    expect(h.stackOf(1)).toBe(600);
  });

  it('three-way: all play the board, pot splits three ways', () => {
    const h = new HandRunner(config, seats([300, 300, 300]));
    const order = h.nextDealOrder();
    h.startHand(
      buildDeck({
        order,
        holes: { 0: '2c 3d', 1: '2h 4s', 2: '5c 6d' },
        board: 'As Ks Qd Jd Th',
      }),
    );
    h.act(h.state.actingSeat!, allIn());
    h.act(h.state.actingSeat!, allIn());
    h.act(h.state.actingSeat!, call());
    h.autoFinish();

    expect(h.payoutOf(0)).toBe(300);
    expect(h.payoutOf(1)).toBe(300);
    expect(h.payoutOf(2)).toBe(300);
    expect(h.totalStacks()).toBe(900);
  });

  it('odd chip on a split goes to the first contesting seat left of the button', () => {
    // seat 1 folds its small blind (5) - dead money makes the pot odd
    const h = new HandRunner(config, seats([200, 200, 200]));
    const order = h.nextDealOrder();
    // 3-handed: button seat 0, SB seat 1, BB seat 2, first to act seat 0
    h.startHand(
      buildDeck({
        order,
        holes: { 0: '2c 3d', 1: '9c 9s', 2: '2h 4s' },
        board: 'As Ks Qd Jd Th',
      }),
    );
    h.act(h.state.actingSeat!, allIn()); // seat 0 -> 200
    h.act(h.state.actingSeat!, fold()); // seat 1 (SB) folds, 5 dead
    h.act(h.state.actingSeat!, call()); // seat 2 (BB) calls all-in -> 200
    h.autoFinish();

    // pot = 200 + 200 + 5 = 405, split between seats 0 and 2 (both play the board)
    const p0 = h.payoutOf(0);
    const p2 = h.payoutOf(2);
    expect(p0 + p2).toBe(405);
    expect(Math.abs(p0 - p2)).toBe(1); // one odd chip
    // seat 2 is the first contesting seat clockwise from button 0
    expect(p2).toBe(203);
    expect(p0).toBe(202);
  });

  it('short stack wins the main pot outright; the two big stacks split the side pot', () => {
    const h = new HandRunner(config, seats([100, 800, 800]));
    const order = h.nextDealOrder();
    h.startHand(
      buildDeck({
        order,
        holes: { 0: 'Ah As', 1: '7h 7d', 2: '7c 7s' },
        board: '2c 5d 8h Jc 3s', // dry board: seat 0 pair of aces, seats 1 & 2 tied pair of 7s
      }),
    );
    h.act(h.state.actingSeat!, allIn()); // seat 0 -> 100
    h.act(h.state.actingSeat!, allIn()); // seat 1 -> 800
    h.act(h.state.actingSeat!, call()); // seat 2 calls 800
    h.autoFinish();

    // main: 100 x 3 = 300 -> seat 0 (pair of aces beats pair of sevens)
    expect(h.payoutOf(0)).toBe(300);
    // side: 700 x 2 = 1400 -> split 700 / 700 between seats 1 and 2
    expect(h.payoutOf(1)).toBe(700);
    expect(h.payoutOf(2)).toBe(700);
    expect(h.totalStacks()).toBe(1700);
  });
});
