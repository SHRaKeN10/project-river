import {
  betTo,
  type BettingContext,
  type BettingRound,
  call,
  check,
  createBettingRound,
  fold,
  raiseTo,
  allIn,
} from '../betting';
import { createPlayer, type PlayerState, PlayerStatus } from '../player/player';
import { legalActions, validateAction, ValidationCode } from './action-validator';

interface SeatSpec {
  seat: number;
  stack: number;
  currentBet?: number;
  hasActed?: boolean;
  status?: PlayerStatus;
}

const mk = ({
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
  players: specs.map(mk),
  round,
  actingSeat,
});

const codeOf = (r: ReturnType<typeof validateAction>) => (r.ok ? 'OK' : r.code);

describe('validateAction: turn & state', () => {
  const base = ctx(
    [
      { seat: 1, stack: 1000 },
      { seat: 2, stack: 1000 },
    ],
    createBettingRound(20, 0),
    1,
  );

  it('rejects acting out of turn', () => {
    expect(codeOf(validateAction(base, 2, check()))).toBe(ValidationCode.NotYourTurn);
  });

  it('rejects acting when folded or all-in', () => {
    const folded = ctx(
      [{ seat: 1, stack: 0, status: PlayerStatus.Folded }],
      createBettingRound(20, 0),
      1,
    );
    expect(codeOf(validateAction(folded, 1, check()))).toBe(ValidationCode.CannotAct);
    const shoved = ctx(
      [{ seat: 1, stack: 0, status: PlayerStatus.AllIn }],
      createBettingRound(20, 0),
      1,
    );
    expect(codeOf(validateAction(shoved, 1, check()))).toBe(ValidationCode.CannotAct);
  });
});

describe('validateAction: check / call', () => {
  it('cannot check facing a bet', () => {
    const facing = ctx([{ seat: 1, stack: 1000, currentBet: 0 }], createBettingRound(20, 40), 1);
    expect(codeOf(validateAction(facing, 1, check()))).toBe(ValidationCode.CannotCheck);
    expect(validateAction(facing, 1, call()).ok).toBe(true);
  });

  it('cannot call when nothing is owed', () => {
    const free = ctx([{ seat: 1, stack: 1000 }], createBettingRound(20, 0), 1);
    expect(codeOf(validateAction(free, 1, call()))).toBe(ValidationCode.NothingToCall);
    expect(validateAction(free, 1, check()).ok).toBe(true);
  });
});

describe('validateAction: bet', () => {
  const round = createBettingRound(20, 0);

  it('accepts a legal opening bet', () => {
    const c = ctx([{ seat: 1, stack: 1000 }], round, 1);
    expect(validateAction(c, 1, betTo(20)).ok).toBe(true);
    expect(validateAction(c, 1, betTo(500)).ok).toBe(true);
  });

  it('rejects a bet below the big blind (unless all-in)', () => {
    const c = ctx([{ seat: 1, stack: 1000 }], round, 1);
    expect(codeOf(validateAction(c, 1, betTo(15)))).toBe(ValidationCode.BelowMinimum);

    const short = ctx([{ seat: 1, stack: 12 }], round, 1);
    expect(validateAction(short, 1, betTo(12)).ok).toBe(true); // all-in for less is fine
  });

  it('rejects a bet bigger than the stack', () => {
    const c = ctx([{ seat: 1, stack: 100 }], round, 1);
    expect(codeOf(validateAction(c, 1, betTo(200)))).toBe(ValidationCode.InsufficientChips);
  });

  it('rejects a bet when a bet already exists (must raise)', () => {
    const c = ctx([{ seat: 1, stack: 1000, currentBet: 0 }], createBettingRound(20, 40), 1);
    expect(codeOf(validateAction(c, 1, betTo(120)))).toBe(ValidationCode.BetNotAllowed);
  });
});

describe('validateAction: raise', () => {
  const preflop = createBettingRound(20, 20);

  it('accepts a legal raise', () => {
    const c = ctx(
      [
        { seat: 1, stack: 1000, currentBet: 0 },
        { seat: 2, stack: 980, currentBet: 20 },
      ],
      preflop,
      1,
    );
    expect(validateAction(c, 1, raiseTo(40)).ok).toBe(true);
    expect(validateAction(c, 1, raiseTo(200)).ok).toBe(true);
  });

  it('rejects a raise below the minimum', () => {
    const c = ctx([{ seat: 1, stack: 1000, currentBet: 0 }], preflop, 1);
    expect(codeOf(validateAction(c, 1, raiseTo(35)))).toBe(ValidationCode.BelowMinimum);
  });

  it('rejects a raise beyond the stack', () => {
    const c = ctx([{ seat: 1, stack: 100, currentBet: 0 }], preflop, 1);
    expect(codeOf(validateAction(c, 1, raiseTo(300)))).toBe(ValidationCode.InsufficientChips);
  });

  it('rejects raising after an incomplete all-in re-raise (already acted, not re-opened)', () => {
    const round: BettingRound = {
      currentBet: 130,
      lastRaiseSize: 100,
      lastAggressorSeat: 9,
      minOpen: 20,
    };
    const c = ctx([{ seat: 1, stack: 900, currentBet: 100, hasActed: true }], round, 1);
    expect(codeOf(validateAction(c, 1, raiseTo(400)))).toBe(ValidationCode.RaiseNotAllowed);
    expect(validateAction(c, 1, call()).ok).toBe(true); // can still call the extra
  });

  it('rejects a raise with no bet outstanding (should bet)', () => {
    const c = ctx([{ seat: 1, stack: 1000 }], createBettingRound(20, 0), 1);
    expect(codeOf(validateAction(c, 1, raiseTo(100)))).toBe(ValidationCode.RaiseNotAllowed);
  });
});

describe('validateAction: fold & all-in', () => {
  it('fold is always legal in turn', () => {
    const c = ctx([{ seat: 1, stack: 1000 }], createBettingRound(20, 0), 1);
    expect(validateAction(c, 1, fold()).ok).toBe(true);
  });

  it('all-in is legal whenever the player has chips', () => {
    const c = ctx([{ seat: 1, stack: 1 }], createBettingRound(20, 500), 1);
    expect(validateAction(c, 1, allIn()).ok).toBe(true);
    const broke = ctx(
      [{ seat: 1, stack: 0, status: PlayerStatus.AllIn }],
      createBettingRound(20, 0),
      1,
    );
    expect(validateAction(broke, 1, allIn()).ok).toBe(false);
  });
});

describe('legalActions', () => {
  it('nothing to call: check + bet + all-in', () => {
    const c = ctx([{ seat: 1, stack: 1000 }], createBettingRound(20, 0), 1);
    const kinds = legalActions(c, 1).map((o) => o.kind);
    expect(kinds).toEqual(expect.arrayContaining(['FOLD', 'CHECK', 'BET', 'ALL_IN']));
    expect(kinds).not.toContain('CALL');
    expect(kinds).not.toContain('RAISE');
    const bet = legalActions(c, 1).find((o) => o.kind === 'BET');
    expect(bet).toMatchObject({ min: 20, max: 1000 });
  });

  it('facing a bet: fold + call + raise + all-in with correct sizing', () => {
    const c = ctx(
      [
        { seat: 1, stack: 1000, currentBet: 0 },
        { seat: 2, stack: 900, currentBet: 100 },
      ],
      { currentBet: 100, lastRaiseSize: 100, lastAggressorSeat: 2, minOpen: 20 },
      1,
    );
    const options = legalActions(c, 1);
    expect(options.map((o) => o.kind)).toEqual(
      expect.arrayContaining(['FOLD', 'CALL', 'RAISE', 'ALL_IN']),
    );
    expect(options.find((o) => o.kind === 'CALL')?.callAmount).toBe(100);
    expect(options.find((o) => o.kind === 'RAISE')).toMatchObject({ min: 200, max: 1000 });
  });

  it('big-blind option: check or raise', () => {
    const c = ctx(
      [
        { seat: 1, stack: 980, currentBet: 20, hasActed: true },
        { seat: 2, stack: 980, currentBet: 20, hasActed: false },
      ],
      createBettingRound(20, 20),
      2,
    );
    const kinds = legalActions(c, 2).map((o) => o.kind);
    expect(kinds).toEqual(expect.arrayContaining(['CHECK', 'RAISE']));
    expect(kinds).not.toContain('CALL');
  });

  it('returns nothing for a player who is not to act', () => {
    const c = ctx(
      [
        { seat: 1, stack: 1000 },
        { seat: 2, stack: 1000 },
      ],
      createBettingRound(20, 0),
      1,
    );
    expect(legalActions(c, 2)).toEqual([]);
  });

  it('short stack facing a bet: no raise option, all-in caps at stack', () => {
    const c = ctx(
      [
        { seat: 1, stack: 30, currentBet: 0 },
        { seat: 2, stack: 900, currentBet: 100 },
      ],
      { currentBet: 100, lastRaiseSize: 100, lastAggressorSeat: 2, minOpen: 20 },
      1,
    );
    const options = legalActions(c, 1);
    expect(options.map((o) => o.kind)).not.toContain('RAISE');
    expect(options.find((o) => o.kind === 'CALL')?.callAmount).toBe(30); // all-in call
  });
});
