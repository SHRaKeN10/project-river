import { createPlayer, type PlayerState, PlayerStatus } from '../player/player';
import {
  amountToCall,
  applyBet,
  applyCall,
  applyCheck,
  applyFold,
  applyRaise,
  type BettingContext,
  type BettingRound,
  createBettingRound,
  isBettingRoundComplete,
  minRaiseTo,
} from './betting';

interface SeatSpec {
  seat: number;
  stack: number;
  currentBet?: number;
  hasActed?: boolean;
  status?: PlayerStatus;
}

const player = ({
  seat,
  stack,
  currentBet = 0,
  hasActed = false,
  status = PlayerStatus.Active,
}: SeatSpec): PlayerState => ({
  ...createPlayer(`u${seat}`, seat, stack),
  status,
  currentBet,
  hasActed,
});

const ctx = (specs: SeatSpec[], round: BettingRound, actingSeat: number): BettingContext => ({
  players: specs.map(player),
  round,
  actingSeat,
});

const seat = (c: BettingContext, s: number): PlayerState =>
  c.players.find((p) => p.seatNumber === s) as PlayerState;

const chipsInPlay = (c: BettingContext): number =>
  c.players.reduce((sum, p) => sum + p.stack + p.currentBet, 0);

describe('betting maths', () => {
  it('amountToCall and minRaiseTo', () => {
    const round = { currentBet: 60, lastRaiseSize: 40, lastAggressorSeat: 1, minOpen: 20 };
    expect(amountToCall(0, round)).toBe(60);
    expect(amountToCall(20, round)).toBe(40);
    expect(amountToCall(60, round)).toBe(0);
    expect(amountToCall(80, round)).toBe(0);
    expect(minRaiseTo(round)).toBe(100);
  });
});

describe('applyBet', () => {
  const round = createBettingRound(20, 0);

  it('opens the betting and records the aggressor', () => {
    const before = ctx(
      [
        { seat: 1, stack: 1000 },
        { seat: 2, stack: 1000 },
      ],
      round,
      1,
    );
    const after = applyBet(before, 60);
    expect(seat(after, 1)).toMatchObject({ stack: 940, currentBet: 60, hasActed: true });
    expect(after.round).toMatchObject({ currentBet: 60, lastRaiseSize: 60, lastAggressorSeat: 1 });
    expect(chipsInPlay(after)).toBe(chipsInPlay(before));
  });

  it('re-opens the action for players who had already checked', () => {
    const before = ctx(
      [
        { seat: 1, stack: 1000, hasActed: true },
        { seat: 2, stack: 1000, hasActed: true },
        { seat: 3, stack: 1000, hasActed: true },
      ],
      round,
      3,
    );
    const after = applyBet(before, 40);
    expect(seat(after, 1).hasActed).toBe(false);
    expect(seat(after, 2).hasActed).toBe(false);
    expect(seat(after, 3).hasActed).toBe(true);
  });

  it('rejects a bet below the minimum unless it is all-in', () => {
    const before = ctx(
      [
        { seat: 1, stack: 1000 },
        { seat: 2, stack: 1000 },
      ],
      round,
      1,
    );
    expect(() => applyBet(before, 15)).toThrow();

    const shortStack = ctx(
      [
        { seat: 1, stack: 12 },
        { seat: 2, stack: 1000 },
      ],
      round,
      1,
    );
    const allIn = applyBet(shortStack, 12);
    expect(seat(allIn, 1).status).toBe(PlayerStatus.AllIn);
    expect(allIn.round.currentBet).toBe(12);
    // a sub-minimum all-in bet does not shrink the next raiser's minimum
    expect(allIn.round.lastRaiseSize).toBe(20);
  });

  it('rejects a bet when one already exists', () => {
    const withBet = ctx([{ seat: 1, stack: 1000 }], createBettingRound(20, 40), 1);
    expect(() => applyBet(withBet, 100)).toThrow();
  });
});

describe('applyRaise', () => {
  const preflop = createBettingRound(20, 20); // currentBet = BB

  it('handles a standard full raise and re-opens the action', () => {
    const before = ctx(
      [
        { seat: 1, stack: 1000, currentBet: 0 },
        { seat: 2, stack: 980, currentBet: 20, hasActed: false },
        { seat: 3, stack: 1000, currentBet: 0, hasActed: true },
      ],
      preflop,
      1,
    );
    const after = applyRaise(before, 60);
    expect(seat(after, 1)).toMatchObject({ stack: 940, currentBet: 60, hasActed: true });
    expect(after.round).toMatchObject({ currentBet: 60, lastRaiseSize: 40, lastAggressorSeat: 1 });
    expect(seat(after, 3).hasActed).toBe(false); // re-opened
    expect(chipsInPlay(after)).toBe(chipsInPlay(before));
  });

  it('enforces the minimum raise size', () => {
    const before = ctx(
      [
        { seat: 1, stack: 1000 },
        { seat: 2, stack: 1000, currentBet: 20 },
      ],
      preflop,
      1,
    );
    expect(() => applyRaise(before, 35)).toThrow(); // increment 15 < 20
    expect(() => applyRaise(before, 40)).not.toThrow(); // increment 20 == min
  });

  it('an incomplete all-in raise does not re-open the action or grow the min raise', () => {
    const round: BettingRound = {
      currentBet: 100,
      lastRaiseSize: 100,
      lastAggressorSeat: 9,
      minOpen: 20,
    };
    const before = ctx(
      [
        { seat: 1, stack: 130, currentBet: 0, hasActed: false }, // will shove for 130
        { seat: 2, stack: 900, currentBet: 100, hasActed: true }, // already acted
        { seat: 3, stack: 900, currentBet: 0, hasActed: false }, // yet to act
      ],
      round,
      1,
    );
    const after = applyRaise(before, 130);
    expect(seat(after, 1)).toMatchObject({ stack: 0, currentBet: 130, status: PlayerStatus.AllIn });
    expect(after.round.currentBet).toBe(130);
    expect(after.round.lastRaiseSize).toBe(100); // unchanged
    expect(seat(after, 2).hasActed).toBe(true); // NOT re-opened
    expect(seat(after, 3).hasActed).toBe(false);
    expect(chipsInPlay(after)).toBe(chipsInPlay(before));
  });

  it('rejects a raise with no bet outstanding', () => {
    const before = ctx([{ seat: 1, stack: 1000 }], createBettingRound(20, 0), 1);
    expect(() => applyRaise(before, 100)).toThrow();
  });
});

describe('applyCall', () => {
  it('matches the current bet', () => {
    const before = ctx(
      [
        { seat: 1, stack: 940, currentBet: 60 },
        { seat: 2, stack: 1000, currentBet: 0 },
      ],
      createBettingRound(20, 60),
      2,
    );
    const after = applyCall(before);
    expect(seat(after, 2)).toMatchObject({ stack: 940, currentBet: 60, hasActed: true });
    expect(after.round.currentBet).toBe(60); // a call never moves the bet
    expect(chipsInPlay(after)).toBe(chipsInPlay(before));
  });

  it('goes all-in for less than a full call without changing the bet', () => {
    const before = ctx(
      [
        { seat: 1, stack: 940, currentBet: 60 },
        { seat: 2, stack: 25, currentBet: 0 },
      ],
      createBettingRound(20, 60),
      2,
    );
    const after = applyCall(before);
    expect(seat(after, 2)).toMatchObject({ stack: 0, currentBet: 25, status: PlayerStatus.AllIn });
    expect(after.round.currentBet).toBe(60);
  });

  it('rejects a call when nothing is owed', () => {
    const before = ctx([{ seat: 1, stack: 1000, currentBet: 0 }], createBettingRound(20, 0), 1);
    expect(() => applyCall(before)).toThrow();
  });
});

describe('applyCheck / applyFold', () => {
  it('check is allowed only with nothing to call', () => {
    const free = ctx([{ seat: 1, stack: 1000 }], createBettingRound(20, 0), 1);
    expect(seat(applyCheck(free), 1).hasActed).toBe(true);

    const facingBet = ctx([{ seat: 1, stack: 1000, currentBet: 0 }], createBettingRound(20, 40), 1);
    expect(() => applyCheck(facingBet)).toThrow();
  });

  it('fold leaves the bet untouched and removes the player from the hand', () => {
    const before = ctx(
      [
        { seat: 1, stack: 1000, currentBet: 0 },
        { seat: 2, stack: 940, currentBet: 60 },
      ],
      createBettingRound(20, 60),
      1,
    );
    const after = applyFold(before);
    expect(seat(after, 1).status).toBe(PlayerStatus.Folded);
    expect(after.round.currentBet).toBe(60);
    expect(chipsInPlay(after)).toBe(chipsInPlay(before));
  });
});

describe('isBettingRoundComplete', () => {
  it('pre-flop: not complete until the big blind takes their option', () => {
    const bbOptionPending = ctx(
      [
        { seat: 1, stack: 980, currentBet: 20, hasActed: true, status: PlayerStatus.Active }, // SB completed
        { seat: 2, stack: 980, currentBet: 20, hasActed: false, status: PlayerStatus.Active }, // BB
      ],
      createBettingRound(20, 20),
      2,
    );
    expect(isBettingRoundComplete(bbOptionPending)).toBe(false);

    const bbChecked = ctx(
      [
        { seat: 1, stack: 980, currentBet: 20, hasActed: true },
        { seat: 2, stack: 980, currentBet: 20, hasActed: true },
      ],
      createBettingRound(20, 20),
      2,
    );
    expect(isBettingRoundComplete(bbChecked)).toBe(true);
  });

  it('complete once everyone still in has acted and matched', () => {
    const done = ctx(
      [
        { seat: 1, stack: 900, currentBet: 100, hasActed: true },
        { seat: 2, stack: 900, currentBet: 100, hasActed: true },
        { seat: 3, stack: 1000, currentBet: 0, status: PlayerStatus.Folded, hasActed: true },
      ],
      createBettingRound(20, 100),
      1,
    );
    expect(isBettingRoundComplete(done)).toBe(true);
  });

  it('complete when only one player remains unfolded', () => {
    const walk = ctx(
      [
        { seat: 1, stack: 1000, currentBet: 20, hasActed: false },
        { seat: 2, stack: 1000, currentBet: 0, status: PlayerStatus.Folded, hasActed: true },
      ],
      createBettingRound(20, 20),
      1,
    );
    expect(isBettingRoundComplete(walk)).toBe(true);
  });

  it('complete when everyone left is all-in', () => {
    const allIn = ctx(
      [
        { seat: 1, stack: 0, currentBet: 300, status: PlayerStatus.AllIn, hasActed: true },
        { seat: 2, stack: 0, currentBet: 500, status: PlayerStatus.AllIn, hasActed: true },
      ],
      createBettingRound(20, 500),
      1,
    );
    expect(isBettingRoundComplete(allIn)).toBe(true);
  });

  it('not complete while an active player still owes chips', () => {
    const owes = ctx(
      [
        { seat: 1, stack: 900, currentBet: 100, hasActed: true },
        { seat: 2, stack: 950, currentBet: 50, hasActed: false },
      ],
      createBettingRound(20, 100),
      2,
    );
    expect(isBettingRoundComplete(owes)).toBe(false);
  });
});

describe('chip conservation (property-ish)', () => {
  it('a full multi-street-style action sequence never creates or destroys chips', () => {
    let context = ctx(
      [
        { seat: 1, stack: 1000 },
        { seat: 2, stack: 1000 },
        { seat: 3, stack: 1000 },
        { seat: 4, stack: 1000 },
      ],
      createBettingRound(20, 0),
      1,
    );
    const start = chipsInPlay(context);

    context = { ...applyBet(context, 60), actingSeat: 2 };
    context = { ...applyRaise(context, 180), actingSeat: 3 };
    context = { ...applyFold(context), actingSeat: 4 };
    context = { ...applyCall(context), actingSeat: 1 };
    context = { ...applyCall(context), actingSeat: 2 };

    expect(chipsInPlay(context)).toBe(start);
    // seats 1, 2 and 4 all end the round at 180; seat 3 folded after putting in 0
    expect(context.players.reduce((s, p) => s + p.currentBet, 0)).toBe(540);
    expect(isBettingRoundComplete(context)).toBe(true);
  });
});
