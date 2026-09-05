import { createPlayer, type PlayerState, PlayerStatus } from '../player/player';
import { validateAction, ValidationCode } from '../action-validator/action-validator';
import { betTo, raiseTo } from './action';
import {
  applyBet,
  applyRaise,
  type BettingContext,
  type BettingRound,
  potLimitMaxTo,
} from './betting';

interface SeatSpec {
  seat: number;
  stack: number;
  currentBet?: number;
}

const player = ({ seat, stack, currentBet = 0 }: SeatSpec): PlayerState => ({
  ...createPlayer(`u${seat}`, seat, stack),
  status: PlayerStatus.Active,
  currentBet,
});

const potLimit = (
  specs: SeatSpec[],
  round: BettingRound,
  actingSeat: number,
  potBeforeRound = 0,
): BettingContext => ({
  players: specs.map(player),
  round,
  actingSeat,
  potBeforeRound,
  bettingLimit: 'POT_LIMIT',
});

const round = (over: Partial<BettingRound> = {}): BettingRound => ({
  currentBet: 0,
  lastRaiseSize: 10,
  lastAggressorSeat: null,
  minOpen: 10,
  ...over,
});

describe('potLimitMaxTo', () => {
  it('opening bet: the cap is the pot itself', () => {
    // Flop, 60 already collected, no bets yet.
    const ctx = potLimit([{ seat: 0, stack: 1000 }], round(), 0, 60);
    expect(potLimitMaxTo(ctx, 0)).toBe(60);
  });

  it('preflop open: call + pot-after-the-call', () => {
    // blinds 5/10 in the current bets, seat 0 (button) to act.
    const ctx = potLimit(
      [
        { seat: 0, stack: 1000 },
        { seat: 1, stack: 1000, currentBet: 5 },
        { seat: 2, stack: 1000, currentBet: 10 },
      ],
      round({ currentBet: 10 }),
      0,
    );
    // 10 (call) + [15 on the table + 10 the caller adds] = 35
    expect(potLimitMaxTo(ctx, 0)).toBe(35);
  });

  it('facing a pot-sized raise, the re-raise cap grows', () => {
    const ctx = potLimit(
      [
        { seat: 0, stack: 1000, currentBet: 35 },
        { seat: 1, stack: 1000, currentBet: 10 },
      ],
      round({ currentBet: 35, lastRaiseSize: 25 }),
      1,
    );
    // owed 25; 35 + [45 on table + 25] = 105
    expect(potLimitMaxTo(ctx, 1)).toBe(105);
  });
});

describe('validateAction under pot-limit', () => {
  const ctx = potLimit(
    [
      { seat: 0, stack: 1000 },
      { seat: 1, stack: 1000, currentBet: 5 },
      { seat: 2, stack: 1000, currentBet: 10 },
    ],
    round({ currentBet: 10 }),
    0,
  );

  it('accepts a raise up to the pot', () => {
    expect(validateAction(ctx, 0, raiseTo(35))).toEqual({ ok: true });
  });

  it('rejects a raise over the pot with ABOVE_MAXIMUM', () => {
    const v = validateAction(ctx, 0, raiseTo(36));
    expect(v).toMatchObject({ ok: false, code: ValidationCode.AboveMaximum });
  });

  it('rejects an over-pot opening bet too', () => {
    const flop = potLimit([{ seat: 0, stack: 1000 }], round(), 0, 40);
    expect(validateAction(flop, 0, betTo(40))).toEqual({ ok: true });
    expect(validateAction(flop, 0, betTo(41))).toMatchObject({
      ok: false,
      code: ValidationCode.AboveMaximum,
    });
  });
});

describe('apply* refuse an over-pot amount (defence in depth)', () => {
  it('applyBet throws past the cap', () => {
    const ctx = potLimit([{ seat: 0, stack: 1000 }], round(), 0, 40);
    expect(() => applyBet(ctx, 41)).toThrow(/pot limit/);
    expect(() => applyBet(ctx, 40)).not.toThrow();
  });

  it('applyRaise throws past the cap', () => {
    const ctx = potLimit(
      [
        { seat: 0, stack: 1000 },
        { seat: 1, stack: 1000, currentBet: 5 },
        { seat: 2, stack: 1000, currentBet: 10 },
      ],
      round({ currentBet: 10 }),
      0,
    );
    expect(() => applyRaise(ctx, 36)).toThrow(/pot limit/);
    expect(() => applyRaise(ctx, 35)).not.toThrow();
  });
});

describe('no-limit is unaffected', () => {
  it('a bet far above the pot is fine when bettingLimit is omitted', () => {
    const ctx: BettingContext = {
      players: [player({ seat: 0, stack: 1000 })],
      round: round(),
      actingSeat: 0,
      potBeforeRound: 10,
    };
    expect(validateAction(ctx, 0, betTo(1000))).toEqual({ ok: true });
  });
});
