import { createPlayer, type PlayerState, PlayerStatus } from '../player/player';
import {
  assignPositions,
  contestingSeats,
  createTableConfig,
  firstToActPostflop,
  isHeadsUp,
  nextSeat,
  type Positions,
  previousPositionsOf,
  seatsForNextHand,
  validateTableConfig,
} from './table';

const seated = (seat: number, stack = 1000, status = PlayerStatus.Active): PlayerState => ({
  ...createPlayer(`u${seat}`, seat, stack),
  status,
});

describe('table config', () => {
  it('fills sensible defaults and derives the small blind', () => {
    const config = createTableConfig({ bigBlind: 20 });
    expect(config).toMatchObject({ smallBlind: 10, bigBlind: 20, maxSeats: 9, ante: 0 });
  });

  it('rejects invalid configs', () => {
    expect(() => createTableConfig({ maxSeats: 1 })).toThrow();
    expect(() => createTableConfig({ maxSeats: 10 })).toThrow();
    expect(() =>
      validateTableConfig({ ...createTableConfig(), smallBlind: 50, bigBlind: 20 }),
    ).toThrow();
    expect(() =>
      validateTableConfig({ ...createTableConfig(), minBuyIn: 999, maxBuyIn: 100 }),
    ).toThrow();
  });
});

describe('seat selection', () => {
  it('seatsForNextHand excludes sitting-out, eliminated, and broke players', () => {
    const players = [
      seated(0, 1000),
      seated(2, 0), // broke
      seated(4, 1000, PlayerStatus.SittingOut),
      seated(6, 1000, PlayerStatus.Eliminated),
      seated(8, 500),
    ];
    expect(seatsForNextHand(players)).toEqual([0, 8]);
  });

  it('contestingSeats returns players still holding cards', () => {
    const players = [
      seated(1, 1000, PlayerStatus.Active),
      seated(3, 0, PlayerStatus.AllIn),
      seated(5, 1000, PlayerStatus.Folded),
    ];
    expect(contestingSeats(players)).toEqual([1, 3]);
  });

  it('nextSeat wraps around', () => {
    expect(nextSeat(2, [0, 2, 5, 7])).toBe(5);
    expect(nextSeat(7, [0, 2, 5, 7])).toBe(0);
    expect(nextSeat(4, [0, 2, 5, 7])).toBe(5);
    expect(nextSeat(9, [0, 2, 5, 7])).toBe(0);
  });
});

describe('assignPositions', () => {
  it('heads-up: the button is the small blind and acts first pre-flop', () => {
    const pos = assignPositions([2, 5], null, 9);
    expect(pos).toEqual({
      buttonSeat: 2,
      smallBlindSeat: 2,
      bigBlindSeat: 5,
      firstToActPreflop: 2,
      deadButton: false,
    });
  });

  it('heads-up: button alternates each hand', () => {
    const first = assignPositions([2, 5], null, 9);
    const second = assignPositions([2, 5], previousPositionsOf(first), 9);
    expect(second.buttonSeat).toBe(5);
    expect(second.smallBlindSeat).toBe(5);
    expect(second.bigBlindSeat).toBe(2);
  });

  it('3-handed first hand: button in the lowest seat, then SB, BB, UTG (= button)', () => {
    const pos = assignPositions([0, 3, 6], null, 9);
    expect(pos).toEqual({
      buttonSeat: 0,
      smallBlindSeat: 3,
      bigBlindSeat: 6,
      firstToActPreflop: 0,
      deadButton: false,
    });
  });

  it('6-handed: standard positions and first hand puts button in the lowest seat', () => {
    const seats = [1, 2, 4, 5, 7, 8];
    const pos = assignPositions(seats, null, 9);
    expect(pos).toEqual({
      buttonSeat: 1,
      smallBlindSeat: 2,
      bigBlindSeat: 4,
      firstToActPreflop: 5,
      deadButton: false,
    });
  });

  it('the big blind advances exactly one live seat per hand (a full orbit)', () => {
    const seats = [1, 2, 3, 4, 5];
    let previous = null as ReturnType<typeof previousPositionsOf> | null;
    const bbSeq: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const pos: Positions = assignPositions(seats, previous, 9);
      bbSeq.push(pos.bigBlindSeat);
      previous = previousPositionsOf(pos);
    }
    expect(bbSeq).toEqual([3, 4, 5, 1, 2]); // every seat posts the BB exactly once
  });

  it('dead small blind: nobody posts the SB when last hand’s big blind has left', () => {
    // hand N: seats 0,2,4,6 -> button 0, SB 2, BB 4
    const prev = previousPositionsOf(assignPositions([0, 2, 4, 6], null, 9));
    // hand N+1: seat 4 (last hand's BB) is gone
    const pos = assignPositions([0, 2, 6], prev, 9);
    expect(pos).toEqual({
      buttonSeat: 2,
      smallBlindSeat: null,
      bigBlindSeat: 6,
      firstToActPreflop: 0,
      deadButton: false,
    });
  });

  it('dead button: an empty seat holds the button when SB and button players both left', () => {
    // hand N: seats 0,2,4,6,8 -> button 0, SB 2, BB 4
    const prev = previousPositionsOf(assignPositions([0, 2, 4, 6, 8], null, 9));
    // hand N+1: seats 0 and 2 are gone
    const pos = assignPositions([4, 6, 8], prev, 9);
    expect(pos).toEqual({
      buttonSeat: 3, // empty seat, one before the SB
      smallBlindSeat: 4,
      bigBlindSeat: 6,
      firstToActPreflop: 8,
      deadButton: true,
    });
  });

  it('needs at least two players', () => {
    expect(() => assignPositions([3], null, 9)).toThrow();
  });

  it('with a stable table the button rotates one seat per hand, hitting each equally', () => {
    const seats = [0, 2, 3, 7];
    let previous = null as ReturnType<typeof previousPositionsOf> | null;
    const visited: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const pos = assignPositions(seats, previous, 9);
      visited.push(pos.buttonSeat);
      previous = previousPositionsOf(pos);
    }
    expect(visited.every((s) => seats.includes(s))).toBe(true);
    for (const seat of seats) {
      expect(visited.filter((s) => s === seat)).toHaveLength(3);
    }
  });
});

describe('firstToActPostflop', () => {
  it('is the first contesting seat clockwise from the button', () => {
    expect(firstToActPostflop(3, [0, 3, 6])).toBe(6);
    expect(firstToActPostflop(6, [0, 3, 6])).toBe(0);
    expect(firstToActPostflop(2, [1, 4, 8])).toBe(4);
  });

  it('returns null with nobody contesting', () => {
    expect(firstToActPostflop(3, [])).toBeNull();
  });
});

describe('isHeadsUp', () => {
  it('is true only for exactly two seats', () => {
    expect(isHeadsUp([1, 2])).toBe(true);
    expect(isHeadsUp([1, 2, 3])).toBe(false);
    expect(isHeadsUp([1])).toBe(false);
  });
});
