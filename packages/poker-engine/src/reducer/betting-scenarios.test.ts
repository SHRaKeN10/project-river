import { allIn, call, check, fold, raiseTo } from '../betting';
import { Street } from '../game-state/game-state';
import { createTableConfig } from '../table/table';
import { buildDeck } from '../testkit/deckBuilder';
import { HandRunner, type Seat } from '../testkit/handRunner';

const config = createTableConfig({ smallBlind: 5, bigBlind: 10 });
const seats = (n: number, stack = 2000): Seat[] =>
  Array.from({ length: n }, (_, i) => ({ userId: `u${i}`, seatNumber: i, stack }));

/** A neutral deck so hands never end early by someone folding a monster. */
function neutralDeck(h: HandRunner): ReturnType<typeof buildDeck> {
  const order = h.nextDealOrder();
  const holes: Record<number, string> = {};
  const pool = ['2c 7d', '2h 8d', '3c 8s', '4h 9s', '5c Td', '6h Jd'];
  order.forEach((seat, i) => {
    holes[seat] = pool[i] as string;
  });
  return buildDeck({ order, holes, board: 'Kc Qs 9h 4d 3s' });
}

describe('betting scenarios through the reducer', () => {
  it('limped pot: SB completes, BB checks, on to the flop', () => {
    const h = new HandRunner(config, seats(3));
    h.startHand(neutralDeck(h));

    h.act(h.state.actingSeat!, call()); // UTG/button (seat 0) limps
    h.act(h.state.actingSeat!, call()); // SB completes
    expect(h.state.street).toBe(Street.Preflop);
    h.act(h.state.actingSeat!, check()); // BB option -> check
    expect(h.state.street).toBe(Street.Flop);
    expect(h.state.collectedPot).toBe(30);
  });

  it('open-raise takes it down when everyone folds (a walk)', () => {
    const h = new HandRunner(config, seats(3));
    h.startHand(neutralDeck(h));

    h.act(h.state.actingSeat!, raiseTo(30));
    h.act(h.state.actingSeat!, fold());
    h.act(h.state.actingSeat!, fold());
    expect(h.state.street).toBe(Street.Complete);
    expect(h.payoutOf(0)).toBe(45); // 30 + SB 5 + BB 10
    expect(h.stackOf(0)).toBe(2000 + 15);
  });

  it('3-bet / 4-bet: minimum raise grows with each full raise', () => {
    const h = new HandRunner(config, seats(3));
    h.startHand(neutralDeck(h));

    h.act(h.state.actingSeat!, raiseTo(30)); // seat 0 opens (raise of 20 over BB)
    expect(h.state.round.currentBet).toBe(30);
    expect(h.state.round.lastRaiseSize).toBe(20);

    h.act(h.state.actingSeat!, raiseTo(80)); // seat 1 3-bets (+50)
    expect(h.state.round.currentBet).toBe(80);
    expect(h.state.round.lastRaiseSize).toBe(50);

    h.act(h.state.actingSeat!, raiseTo(200)); // seat 2 4-bets (+120 >= 50)
    expect(h.state.round.currentBet).toBe(200);
    expect(h.state.round.lastRaiseSize).toBe(120);

    // a 5-bet below +120 is rejected
    const bad = h.act(h.state.actingSeat!, raiseTo(280));
    expect(bad.events[0]?.type).toBe('ACTION_REJECTED');
    // the legal minimum (200 + 120 = 320) is accepted
    h.act(h.state.actingSeat!, raiseTo(320));
    expect(h.state.round.currentBet).toBe(320);
  });

  it('check-raise on the flop', () => {
    const h = new HandRunner(config, seats(2));
    h.startHand(neutralDeck(h));
    h.act(h.state.actingSeat!, call()); // SB completes
    h.act(h.state.actingSeat!, check()); // BB checks -> flop
    expect(h.state.street).toBe(Street.Flop);

    // flop: first to act (BB, seat 1) checks, seat 0 bets, seat 1 check-raises
    const firstToAct = h.state.actingSeat!;
    h.act(firstToAct, check());
    h.act(h.state.actingSeat!, { type: 'BET', amount: 20 });
    const raise = h.act(firstToAct, raiseTo(60));
    expect(raise.events.some((e) => e.type === 'PLAYER_RAISED')).toBe(true);
    expect(h.state.round.currentBet).toBe(60);
  });

  it('the big blind option re-opens the betting when exercised', () => {
    const h = new HandRunner(config, seats(3));
    h.startHand(neutralDeck(h));
    h.act(h.state.actingSeat!, call()); // seat 0 limps
    h.act(h.state.actingSeat!, call()); // SB completes
    // BB raises instead of checking -> seats 0 & SB must act again
    const bbSeat = h.state.actingSeat!;
    h.act(bbSeat, raiseTo(40));
    expect(h.state.street).toBe(Street.Preflop);
    expect(h.state.actingSeat).not.toBe(bbSeat);
    h.autoFinish();
    expect(h.chips()).toBe(6000);
  });

  it('an incomplete all-in re-raise does not re-open the action for players who already acted', () => {
    const h = new HandRunner(config, [
      { userId: 'a', seatNumber: 0, stack: 2000 },
      { userId: 'b', seatNumber: 1, stack: 2000 },
      { userId: 'c', seatNumber: 2, stack: 135 }, // short
    ]);
    h.startHand(neutralDeck(h));

    h.act(h.state.actingSeat!, raiseTo(100)); // seat 0 opens to 100
    h.act(h.state.actingSeat!, call()); // seat 1 (SB) calls 100
    // seat 2 (BB, 135 total) shoves for 135 - an incomplete raise (+35 < 90)
    h.act(h.state.actingSeat!, allIn());
    expect(h.state.round.currentBet).toBe(135);
    expect(h.state.round.lastRaiseSize).toBe(90); // unchanged - not a full raise

    // seat 0 already acted: may call/fold but NOT raise
    const cannotRaise = h.act(0, raiseTo(400));
    expect(cannotRaise.events[0]?.type).toBe('ACTION_REJECTED');
    h.act(0, call());
    h.act(1, call());
    h.autoFinish();
    expect(h.chips()).toBe(4135);
  });
});
