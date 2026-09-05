import { call, check } from '../betting';
import { type GameEvent } from '../events/events';
import { Street } from '../game-state/game-state';
import { createTableConfig } from '../table/table';
import { GameVariant } from '../variant/variant';
import { buildDeck } from '../testkit/deckBuilder';
import { HandRunner, type Seat } from '../testkit/handRunner';

const config = createTableConfig({
  variant: GameVariant.Omaha5HiLo,
  smallBlind: 5,
  bigBlind: 10,
  maxSeats: 6,
});
const seats = (n: number, stack = 2000): Seat[] =>
  Array.from({ length: n }, (_, i) => ({ userId: `u${i}`, seatNumber: i, stack }));

/** All three limp/check to showdown for a clean 30-chip pot. */
function checkDown(h: HandRunner): void {
  h.act(h.state.actingSeat!, call()); // seat 0
  h.act(h.state.actingSeat!, call()); // seat 1 (SB completes)
  h.act(h.state.actingSeat!, check()); // seat 2 (BB option)
  h.autoFinish();
}

const potAwards = (events: GameEvent[]) =>
  events.filter((e): e is Extract<GameEvent, { type: 'POT_AWARDED' }> => e.type === 'POT_AWARDED');

describe('Big O (five-card Omaha hi/lo) through the reducer', () => {
  it('deals five hole cards and caps the table at eight seats', () => {
    expect(createTableConfig({ variant: GameVariant.Omaha5HiLo }).maxSeats).toBe(8);
    expect(() => createTableConfig({ variant: GameVariant.Omaha5HiLo, maxSeats: 9 })).toThrow(
      /at most 8 seats/,
    );

    const h = new HandRunner(config, seats(3));
    h.startHand(
      buildDeck({
        order: h.nextDealOrder(),
        holeCount: 5,
        holes: { 0: 'Kc Kd Qh Qc Jd', 1: '9c 9d Ts Th Js', 2: 'Ac 2c 3d 5h 6s' },
        board: 'Ah 7c 8d Ks 2h',
      }),
    );
    for (const p of h.state.players) expect(p.holeCards).toHaveLength(5);
  });

  it('splits the pot: trips win the high, the wheel-ish low wins the low half', () => {
    const h = new HandRunner(config, seats(3));
    h.startHand(
      buildDeck({
        order: h.nextDealOrder(),
        holeCount: 5,
        holes: { 0: 'Kc Kd Qh Qc Jd', 1: '9c 9d Ts Th Js', 2: 'Ac 2c 3d 5h 6s' },
        board: 'Ah 7c 8d Ks 2h',
      }),
    );
    checkDown(h);
    expect(h.state.street).toBe(Street.Complete);
    expect(h.chips()).toBe(6000);

    // pot 30 -> high half 15 (seat 0, trip kings), low half 15 (seat 2, 8-7-3-2-A)
    expect(h.payoutOf(0)).toBe(15);
    expect(h.payoutOf(2)).toBe(15);
    expect(h.payoutOf(1)).toBe(0);
    expect(h.stackOf(0)).toBe(2005);
    expect(h.stackOf(1)).toBe(1990);
    expect(h.stackOf(2)).toBe(2005);

    const awards = potAwards(h.events);
    expect(awards.map((a) => a.portion)).toEqual(['HIGH', 'LOW']);
    expect(awards.find((a) => a.portion === 'HIGH')!.winners).toEqual([{ seat: 0, amount: 15 }]);
    expect(awards.find((a) => a.portion === 'LOW')!.winners).toEqual([{ seat: 2, amount: 15 }]);

    const reveal2 = h.events.find(
      (e) => e.type === 'HAND_REVEALED' && (e as { seat: number }).seat === 2,
    ) as Extract<GameEvent, { type: 'HAND_REVEALED' }>;
    expect(reveal2.low?.description).toBe('7-5-3-2-A low');
  });

  it('scoops the whole pot when one hand wins both halves', () => {
    const h = new HandRunner(config, seats(3));
    h.startHand(
      buildDeck({
        order: h.nextDealOrder(),
        holeCount: 5,
        holes: { 0: 'Ac 5c Kd Qs Jh', 1: 'Th Ts 9h 9d 8s', 2: 'Kc Kd Qc Qh Js' },
        board: '2c 3c 4c Kh Qd',
      }),
    );
    checkDown(h);
    // seat 0: A-2-3-4-5 straight flush in clubs (unbeatable high) and the wheel
    // for the low - it wins both halves.
    expect(h.payoutOf(0)).toBe(30);
    expect(h.payoutOf(1)).toBe(0);
    expect(h.payoutOf(2)).toBe(0);
    expect(h.chips()).toBe(6000);
    const awards = potAwards(h.events);
    expect(awards).toHaveLength(2); // still a hi/lo split, seat 0 wins both
    expect(new Set(awards.flatMap((a) => a.winners.map((w) => w.seat)))).toEqual(new Set([0]));
  });

  it('gives the whole pot to the high hand when no low qualifies', () => {
    const h = new HandRunner(config, seats(3));
    h.startHand(
      buildDeck({
        order: h.nextDealOrder(),
        holeCount: 5,
        holes: { 0: 'Ah Ad Kh 2c 3c', 1: '9h 9d 8c 7c 6d', 2: 'Kd Ks Qc Qh Jc' },
        board: 'Kc Qd Jh Ts 9s',
      }),
    );
    checkDown(h);
    // board is all nine-or-higher: nobody can make an eight-or-better low
    expect(h.payoutOf(0)).toBe(30); // A-K + Q-J-T broadway straight
    const awards = potAwards(h.events);
    expect(awards).toHaveLength(1);
    expect(awards[0]!.portion).toBeUndefined();
    expect(awards[0]!.winners).toEqual([{ seat: 0, amount: 30 }]);
  });

  it('quarters the low between two identical lows; the odd chip follows the button', () => {
    const h = new HandRunner(config, seats(3));
    h.startHand(
      buildDeck({
        order: h.nextDealOrder(),
        holeCount: 5,
        holes: { 0: 'Ah 2h 6c 7c 8d', 1: 'Kh Kd Qh Qd Js', 2: 'Ac 2c 9h 9d Ts' },
        board: '3c 4d 5h Kc Qs',
      }),
    );
    checkDown(h);
    // seat 0 & seat 2 both make A-2-3-4-5 (the wheel); seat 0 also has 3-4-5-6-7
    expect(h.chips()).toBe(6000);
    // high half 15 -> seat 0; low half 15 -> quartered 8 / 7, the odd chip to
    // seat 2 (first low winner clockwise from the button)
    expect(h.payoutOf(0)).toBe(15 + 7);
    expect(h.payoutOf(2)).toBe(8);
    expect(h.payoutOf(1)).toBe(0);
  });
});
