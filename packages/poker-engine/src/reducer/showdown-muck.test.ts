import { allIn, betTo, call, check, raiseTo } from '../betting';
import { type GameEvent } from '../events/events';
import { Street } from '../game-state/game-state';
import { createTableConfig } from '../table/table';
import { buildDeck } from '../testkit/deckBuilder';
import { HandRunner, type Seat } from '../testkit/handRunner';

const config = createTableConfig({ smallBlind: 5, bigBlind: 10 });
const seats = (stacks: number[]): Seat[] =>
  stacks.map((stack, i) => ({ userId: `u${i}`, seatNumber: i, stack }));

const typesOf = (events: GameEvent[]) => events.map((e) => e.type);
const muckedSeats = (events: GameEvent[]) =>
  events.filter((e) => e.type === 'HAND_MUCKED').map((e) => (e as { seat: number }).seat);
const revealedSeats = (events: GameEvent[]) =>
  events.filter((e) => e.type === 'HAND_REVEALED').map((e) => (e as { seat: number }).seat);

describe('auto-muck at showdown', () => {
  it('a beaten caller mucks after a river bet-call rather than expose their hand', () => {
    const h = new HandRunner(config, seats([1000, 1000]));
    // heads-up: seat 0 = button/SB, seat 1 = BB. seat 1 makes trip aces.
    h.startHand(
      buildDeck({
        order: h.nextDealOrder(),
        holes: { 0: '2c 3d', 1: 'Ac Ad' },
        board: 'As Kh 7s 4h 9c',
      }),
    );
    h.act(0, call()); // button limps
    h.act(1, check()); // BB checks -> flop
    h.act(1, check());
    h.act(0, check()); // -> turn
    h.act(1, check());
    h.act(0, check()); // -> river
    h.act(1, betTo(60)); // BB (best hand) bets
    h.act(0, call()); // button calls with the worse hand

    expect(h.state.street).toBe(Street.Complete);
    expect(revealedSeats(h.events)).toEqual([1]); // only the bettor shows
    expect(muckedSeats(h.events)).toEqual([0]); // the loser mucks
    expect(h.payoutOf(1)).toBe(140); // 10 + 10 blinds + 60 + 60
    expect(h.chips()).toBe(2000);
  });

  it('still tables every hand when the pot went all-in (a run-out)', () => {
    const h = new HandRunner(config, seats([500, 500]));
    h.startHand(
      buildDeck({
        order: h.nextDealOrder(),
        holes: { 0: '2c 3d', 1: 'Ac Ad' },
        board: 'As Kh 7s 4h 9c',
      }),
    );
    h.act(0, allIn());
    h.act(1, call()); // all-in showdown, no betting left

    expect(h.state.street).toBe(Street.Complete);
    expect(muckedSeats(h.events)).toEqual([]);
    expect(revealedSeats(h.events).sort()).toEqual([0, 1]); // both hands tabled
  });

  it('an all-in short stack is always tabled even while others keep betting', () => {
    const h = new HandRunner(config, seats([40, 1000, 1000]));
    // 3-handed: button 0, SB 1, BB 2. Seat 1 wins, seat 0 (all-in) is worst,
    // seat 2 is beaten by seat 1 and mucks.
    h.startHand(
      buildDeck({
        order: h.nextDealOrder(),
        holes: { 0: '2c 3d', 1: 'Ac Ad', 2: 'Kc Qd' },
        board: 'As Kh 7s 4h 9c',
      }),
    );
    h.act(0, allIn()); // seat 0: 40 in (SB/BB already posted for 1 & 2)
    h.act(1, call());
    h.act(2, call()); // -> flop, main pot 120 + side between 1 & 2
    h.act(1, betTo(50));
    h.act(2, call()); // -> turn
    h.act(1, check());
    h.act(2, check()); // -> river
    h.act(1, betTo(120));
    h.act(2, call());

    expect(h.state.street).toBe(Street.Complete);
    expect(revealedSeats(h.events).sort()).toEqual([0, 1]); // short all-in tabled, winner tabled
    expect(muckedSeats(h.events)).toEqual([2]); // seat 2 called the river and lost
    expect(h.chips()).toBe(2040);
    expect(typesOf(h.events)).toContain('POT_AWARDED');
  });

  it('a player mucks the main pot but is tabled to claim a side pot', () => {
    // seat 0 covers everyone and has the nut hand for the MAIN pot only via
    // being beaten there, but wins a side pot outright. Construct: seat 1 short
    // all-in with the best hand takes the main; seat 0 and seat 2 contest the
    // side; seat 0 wins the side, seat 2 mucks.
    const h = new HandRunner(config, seats([1000, 60, 1000]));
    h.startHand(
      buildDeck({
        order: h.nextDealOrder(),
        holes: { 0: 'Ah Ks', 1: 'Ac Ad', 2: '2c 7d' },
        board: 'As Kh 7s 4h 9c',
      }),
    );
    // 3-handed: button 0, SB 1, BB 2.
    h.act(0, raiseTo(60)); // button raises to 60
    h.act(1, allIn()); // SB all-in for 60 total
    h.act(2, call()); // BB calls 60
    // flop: seats 0 & 2 still have chips; seat 1 all-in
    h.act(2, check());
    h.act(0, betTo(100));
    h.act(2, call()); // turn
    h.act(2, check());
    h.act(0, betTo(100));
    h.act(2, call()); // river
    h.act(2, check());
    h.act(0, betTo(100));
    h.act(2, call());

    expect(h.state.street).toBe(Street.Complete);
    // seat 1 wins the main (trip aces); seat 0 (two pair A/K) beats seat 2 for the side
    expect(h.payoutOf(1)).toBe(180); // main pot: 60 * 3
    expect(revealedSeats(h.events).sort()).toEqual([0, 1]);
    expect(muckedSeats(h.events)).toEqual([2]);
    expect(h.chips()).toBe(2060);
  });
});
