import { createPlayer, type PlayerState, PlayerStatus } from '../player/player';
import {
  assignPositions,
  contestingSeats,
  createTableConfig,
  firstToActPostflop,
  isHeadsUp,
  nextSeat,
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
    const pos = assignPositions([2, 5], null);
    expect(pos).toEqual({
      buttonSeat: 2,
      smallBlindSeat: 2,
      bigBlindSeat: 5,
      firstToActPreflop: 2,
    });
  });

  it('heads-up: button alternates each hand', () => {
    const first = assignPositions([2, 5], null);
    const second = assignPositions([2, 5], first.buttonSeat);
    expect(second.buttonSeat).toBe(5);
    expect(second.smallBlindSeat).toBe(5);
    expect(second.bigBlindSeat).toBe(2);
  });

  it('3-handed: button, SB, BB, then UTG (= button) acts first', () => {
    const pos = assignPositions([0, 3, 6], 0);
    expect(pos).toEqual({
      buttonSeat: 3,
      smallBlindSeat: 6,
      bigBlindSeat: 0,
      firstToActPreflop: 3,
    });
  });

  it('6-handed: standard positions and first hand puts button in the lowest seat', () => {
    const seats = [1, 2, 4, 5, 7, 8];
    const pos = assignPositions(seats, null);
    expect(pos).toEqual({
      buttonSeat: 1,
      smallBlindSeat: 2,
      bigBlindSeat: 4,
      firstToActPreflop: 5,
    });
  });

  it('skips empty seats when advancing the button', () => {
    const pos = assignPositions([0, 1, 5], 1); // seats 2,3,4 empty
    expect(pos.buttonSeat).toBe(5);
    expect(pos.smallBlindSeat).toBe(0);
    expect(pos.bigBlindSeat).toBe(1);
  });

  it('needs at least two players', () => {
    expect(() => assignPositions([3], null)).toThrow();
  });

  it('rotates cleanly over many hands without landing on an empty seat', () => {
    const seats = [0, 2, 3, 7];
    let button: number | null = null;
    const visited: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const pos = assignPositions(seats, button);
      visited.push(pos.buttonSeat);
      button = pos.buttonSeat;
    }
    expect(visited.every((s) => seats.includes(s))).toBe(true);
    // over 12 hands each of 4 seats gets the button 3 times
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
