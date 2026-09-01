import { allIn, call, fold, raiseTo } from '../betting';
import { Street } from '../game-state/game-state';
import { createTableConfig } from '../table/table';
import { buildDeck } from '../testkit/deckBuilder';
import { HandRunner, type Seat } from '../testkit/handRunner';

const config = createTableConfig({ smallBlind: 5, bigBlind: 10 });

const seats = (stacks: number[]): Seat[] =>
  stacks.map((stack, i) => ({ userId: `u${i}`, seatNumber: i, stack }));

describe('side pots through the full reducer (deterministic decks)', () => {
  it('short all-in wins the main pot; the two big stacks contest the side pot', () => {
    const h = new HandRunner(config, seats([100, 1000, 1000]));
    const order = h.nextDealOrder();
    h.startHand(
      buildDeck({
        order,
        holes: { 0: 'Ah As', 1: 'Kh Ks', 2: 'Qh Qs' },
        board: '2c 7d 9h Jd 3s',
      }),
    );

    // pre-flop: seat 0 (button, first to act 3-handed) jams 100, both call
    h.act(h.state.actingSeat!, allIn()); // seat 0 -> 100
    h.act(h.state.actingSeat!, call()); // SB -> 100
    h.act(h.state.actingSeat!, call()); // BB -> 100
    expect(h.state.street).toBe(Street.Flop);

    // flop: seat 1 bets 200, seat 2 calls -> a side pot forms
    h.act(h.state.actingSeat!, { type: 'BET', amount: 200 });
    h.act(h.state.actingSeat!, call());
    // turn + river checked down
    h.autoFinish();

    expect(h.state.street).toBe(Street.Complete);
    expect(h.payoutOf(0)).toBe(300); // main pot: 100 x 3, AA
    expect(h.payoutOf(1)).toBe(400); // side pot: 200 x 2, KK beats QQ
    expect(h.payoutOf(2)).toBe(0);
    expect(h.stackOf(0)).toBe(300);
    expect(h.stackOf(1)).toBe(1000 - 300 + 400);
    expect(h.stackOf(2)).toBe(1000 - 300);
    expect(h.totalStacks()).toBe(2100);
  });

  it('three all-ins at three stack sizes create three pots, each to its best eligible hand', () => {
    // seat 0: 60 (worst hand), seat 1: 300 (best hand), seat 2: 1000 (middle)
    const h = new HandRunner(config, seats([60, 300, 1000]));
    const order = h.nextDealOrder();
    h.startHand(
      buildDeck({
        order,
        holes: { 0: '7h 2d', 1: 'Ah Ad', 2: 'Kh Kd' },
        board: '3c 8s Tc Jd 4h',
      }),
    );

    h.act(h.state.actingSeat!, allIn()); // seat 0 -> 60 (all in)
    h.act(h.state.actingSeat!, allIn()); // SB (seat 1) -> 300
    h.act(h.state.actingSeat!, allIn()); // BB (seat 2) -> 1000, but only 300 is called
    h.autoFinish();

    expect(h.state.street).toBe(Street.Complete);
    // pot 1: 60 x 3 = 180  -> seat 1 (AA) - eligible {0,1,2}
    // pot 2: 240 x 2 = 480 -> seat 1 (AA) - eligible {1,2}
    // seat 2's excess over seat 1 (1000 - 300 = 700) is uncalled and returned
    expect(h.payoutOf(1)).toBe(660);
    expect(h.payoutOf(0)).toBe(0);
    expect(h.payoutOf(2)).toBe(0);
    expect(h.stackOf(0)).toBe(0);
    expect(h.stackOf(1)).toBe(660);
    expect(h.stackOf(2)).toBe(700); // uncalled bet back
    expect(h.totalStacks()).toBe(1360);
  });

  it('the middle stack can win the side pot when the short stack wins the main', () => {
    const h = new HandRunner(config, seats([80, 400, 400]));
    const order = h.nextDealOrder();
    h.startHand(
      buildDeck({
        order,
        holes: { 0: 'Ah As', 1: 'Kh Kd', 2: 'Qh Qd' },
        board: '2c 5d 9h Jd 3s',
      }),
    );
    h.act(h.state.actingSeat!, allIn()); // seat 0 -> 80
    h.act(h.state.actingSeat!, allIn()); // seat 1 -> 400
    h.act(h.state.actingSeat!, call()); // seat 2 calls 400
    h.autoFinish();

    // main: 80 x 3 = 240 -> seat 0 (AA)
    // side: 320 x 2 = 640 -> seat 1 (KK beats QQ)
    expect(h.payoutOf(0)).toBe(240);
    expect(h.payoutOf(1)).toBe(640);
    expect(h.payoutOf(2)).toBe(0);
    expect(h.totalStacks()).toBe(880);
  });

  it('refunds a layer no contesting player reached (all high bettors fold)', () => {
    // 3 handed: seat 0 short all-in, seats 1 & 2 bet over the top then both fold
    const h = new HandRunner(config, seats([50, 1000, 1000]));
    const order = h.nextDealOrder();
    h.startHand(
      buildDeck({
        order,
        holes: { 0: 'Ah Ad', 1: '7c 2d', 2: '8c 3d' },
        board: 'Ks Qs Js 4h 5c',
      }),
    );
    h.act(h.state.actingSeat!, allIn()); // seat 0 -> 50
    h.act(h.state.actingSeat!, raiseTo(300)); // seat 1 raises to 300
    h.act(h.state.actingSeat!, call()); // seat 2 calls 300
    expect(h.state.street).toBe(Street.Flop);
    h.act(h.state.actingSeat!, { type: 'BET', amount: 500 }); // seat 1 bets
    h.act(h.state.actingSeat!, fold()); // seat 2 folds
    // seat 1 is now the only non-all-in player left; hand ends
    h.autoFinish();

    // seat 0 (AA) wins the main pot it was eligible for (50 x 3 = 150)
    expect(h.payoutOf(0)).toBe(150);
    // seats 1 & 2's chips above 50 that only they contested are returned
    expect(h.totalStacks()).toBe(2050);
    expect(h.stackOf(0)).toBe(150);
    // chip conservation holds regardless of the exact 1/2 split of dead money
    expect(h.stackOf(1) + h.stackOf(2)).toBe(2050 - 150);
  });

  it('an all-in for less than a call is a partial call, not a raise', () => {
    const h = new HandRunner(config, seats([1000, 1000, 25]));
    const order = h.nextDealOrder();
    h.startHand(
      buildDeck({
        order,
        holes: { 0: 'Ah As', 1: '7c 2d', 2: 'Kh Kd' },
        board: '3c 8s Tc Jd 4h',
      }),
    );
    // seat 0 opens to 200, seat 1 folds, seat 2 (BB, 25 behind after posting 10) is all-in for 25 total
    h.act(h.state.actingSeat!, raiseTo(200));
    h.act(h.state.actingSeat!, fold());
    h.act(h.state.actingSeat!, allIn()); // seat 2 -> 25 total (call for less)
    h.autoFinish();

    // seat 2 only contested 25; seat 0's uncalled 175 comes back
    // main pot = 25 (seat2) + 25 (seat0 matched) + 5 (seat1 dead SB) = 55 -> seat 0 (AA)
    expect(h.payoutOf(0)).toBe(55);
    expect(h.stackOf(2)).toBe(0);
    expect(h.totalStacks()).toBe(2025);
  });
});
