import { allIn, betTo, call, check, fold, raiseTo } from '../betting';
import { legalActions } from '../action-validator';
import { Street } from '../game-state/game-state';
import { HandCategory } from '../hand-evaluator/hand-rank';
import { createTableConfig } from '../table/table';
import { GameVariant } from '../variant/variant';
import { buildDeck } from '../testkit/deckBuilder';
import { HandRunner, type Seat } from '../testkit/handRunner';

const config = createTableConfig({
  variant: GameVariant.Omaha,
  smallBlind: 5,
  bigBlind: 10,
  maxSeats: 6,
});
const seats = (n: number, stack = 2000): Seat[] =>
  Array.from({ length: n }, (_, i) => ({ userId: `u${i}`, seatNumber: i, stack }));

/** 3-handed Omaha deck: seat 0 makes the nut flush, seat 2 has aces. */
function riggedDeck(h: HandRunner) {
  const order = h.nextDealOrder(); // [1, 2, 0]
  return buildDeck({
    order,
    holeCount: 4,
    holes: {
      0: 'Qh Jh 2s 2d',
      1: '7c 8c 9d Td',
      2: 'Ac As 4c 5c',
    },
    board: 'Ah Kh 7h 2c 3d',
  });
}

describe('Omaha through the reducer', () => {
  it('deals four hole cards to every seat', () => {
    const h = new HandRunner(config, seats(3));
    h.startHand(riggedDeck(h));
    for (const p of h.state.players) {
      expect(p.holeCards).toHaveLength(4);
    }
  });

  it('pot-limit caps the opening raise; an over-pot raise is rejected', () => {
    const h = new HandRunner(config, seats(3));
    h.startHand(riggedDeck(h));

    // seat 0 acts first 3-handed. Pot is SB 5 + BB 10; a pot-sized open is
    // to 10 (call) + 25 (pot after the call) = 35.
    const seat = h.state.actingSeat!;
    const raise = legalActions(
      {
        players: h.state.players,
        round: h.state.round,
        actingSeat: seat,
        potBeforeRound: h.state.collectedPot,
        bettingLimit: 'POT_LIMIT',
      },
      seat,
    ).find((o) => o.kind === 'RAISE')!;
    expect(raise.min).toBe(20);
    expect(raise.max).toBe(35);

    const rejected = h.act(seat, raiseTo(36));
    expect(rejected.events[0]).toMatchObject({ type: 'ACTION_REJECTED', code: 'ABOVE_MAXIMUM' });
    expect(h.state.round.currentBet).toBe(10); // unchanged

    h.act(seat, raiseTo(35));
    expect(h.state.round.currentBet).toBe(35);
  });

  it('a deep-stack "all in" becomes a pot-sized raise, not the whole stack', () => {
    const h = new HandRunner(config, seats(3));
    h.startHand(riggedDeck(h));
    const seat = h.state.actingSeat!;

    h.act(seat, allIn());
    expect(h.state.round.currentBet).toBe(35); // the pot, not 2000
    expect(h.stackOf(seat)).toBe(1965);
    expect(h.state.players.find((p) => p.seatNumber === seat)!.status).toBe('ACTIVE');
  });

  it('a short stack still goes all in for less than the pot', () => {
    const h = new HandRunner(config, [
      { userId: 'u0', seatNumber: 0, stack: 18 },
      { userId: 'u1', seatNumber: 1, stack: 2000 },
      { userId: 'u2', seatNumber: 2, stack: 2000 },
    ]);
    h.startHand(riggedDeck(h));
    const seat = h.state.actingSeat!;
    h.act(seat, allIn());
    expect(h.stackOf(seat)).toBe(0);
    expect(h.state.players.find((p) => p.seatNumber === seat)!.status).toBe('ALL_IN');
  });

  it('plays a full hand and settles it by the two-hole-card rule', () => {
    const h = new HandRunner(config, seats(3));
    h.startHand(riggedDeck(h));
    expect(h.chips()).toBe(6000);

    h.act(h.state.actingSeat!, raiseTo(35)); // seat 0 opens to the pot
    h.act(h.state.actingSeat!, call()); // seat 1 (SB) calls
    h.act(h.state.actingSeat!, call()); // seat 2 (BB) calls
    expect(h.state.street).toBe(Street.Flop);
    expect(h.state.collectedPot).toBe(105);

    h.act(h.state.actingSeat!, check()); // seat 1
    h.act(h.state.actingSeat!, check()); // seat 2

    // seat 0 bets the pot on the flop: 105.
    const seat0 = h.state.actingSeat!;
    expect(h.act(seat0, betTo(106)).events[0]).toMatchObject({
      type: 'ACTION_REJECTED',
      code: 'ABOVE_MAXIMUM',
    });
    h.act(seat0, betTo(105));

    h.act(h.state.actingSeat!, fold()); // seat 1 folds
    h.act(h.state.actingSeat!, call()); // seat 2 calls 105

    h.autoFinish(); // turn + river checked through
    expect(h.state.street).toBe(Street.Complete);

    // seat 0: Qh Jh + Ah Kh 7h = ace-high flush, beats seat 2's trip aces.
    expect(h.payoutOf(0)).toBe(315);
    expect(h.stackOf(0)).toBe(2175);
    expect(h.stackOf(2)).toBe(1860);
    expect(h.chips()).toBe(6000);

    const reveal0 = h.events.find(
      (e) => e.type === 'HAND_REVEALED' && (e as { seat: number }).seat === 0,
    ) as { hand: { category: HandCategory } } | undefined;
    expect(reveal0?.hand.category).toBe(HandCategory.Flush);
  });
});
