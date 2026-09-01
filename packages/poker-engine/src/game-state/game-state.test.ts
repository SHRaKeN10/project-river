import { createBettingRound } from '../betting/betting';
import { freshDeck } from '../deck/deck';
import { createPlayer, type PlayerState, PlayerStatus } from '../player/player';
import { createTableConfig } from '../table/table';
import {
  actingPlayers,
  contestingPlayers,
  type GameState,
  getPlayer,
  isHandOver,
  nextActingSeat,
  playersInHand,
  type Pot,
  Street,
  toCall,
  totalPot,
} from './game-state';

interface SeatSpec {
  seat: number;
  stack: number;
  currentBet?: number;
  status?: PlayerStatus;
}

const mk = ({
  seat,
  stack,
  currentBet = 0,
  status = PlayerStatus.Active,
}: SeatSpec): PlayerState => ({
  ...createPlayer(`u${seat}`, seat, stack),
  status,
  currentBet,
});

const state = (specs: SeatSpec[], overrides: Partial<GameState> = {}): GameState => ({
  tableId: 't1',
  handId: 'h1',
  handNumber: 1,
  config: createTableConfig({ bigBlind: 20 }),
  street: Street.Flop,
  buttonSeat: specs[0]?.seat ?? 0,
  smallBlindSeat: 0,
  bigBlindSeat: 0,
  communityCards: [],
  players: specs.map(mk).sort((a, b) => a.seatNumber - b.seatNumber),
  actingSeat: specs[0]?.seat ?? null,
  round: createBettingRound(20, overrides.round?.currentBet ?? 0),
  deck: freshDeck(),
  collectedPot: 0,
  pots: [],
  actionDeadline: null,
  ...overrides,
});

describe('game-state selectors', () => {
  const s = state([
    { seat: 0, stack: 900, currentBet: 100, status: PlayerStatus.Active },
    { seat: 2, stack: 0, currentBet: 300, status: PlayerStatus.AllIn },
    { seat: 4, stack: 1000, currentBet: 0, status: PlayerStatus.Folded },
    { seat: 6, stack: 1000, currentBet: 0, status: PlayerStatus.SittingOut },
  ]);

  it('getPlayer looks up by seat', () => {
    expect(getPlayer(s, 2)?.userId).toBe('u2');
    expect(getPlayer(s, 99)).toBeUndefined();
  });

  it('actingPlayers = ACTIVE only', () => {
    expect(actingPlayers(s).map((p) => p.seatNumber)).toEqual([0]);
  });

  it('playersInHand = ACTIVE + ALL_IN', () => {
    expect(playersInHand(s).map((p) => p.seatNumber)).toEqual([0, 2]);
  });

  it('contestingPlayers excludes folded and sitting-out', () => {
    expect(contestingPlayers(s).map((p) => p.seatNumber)).toEqual([0, 2]);
  });

  it('totalPot sums committed pots and on-table bets', () => {
    const withPots = state(
      [
        { seat: 0, stack: 900, currentBet: 100 },
        { seat: 1, stack: 900, currentBet: 100 },
      ],
      { pots: [{ amount: 300, eligibleSeats: [0, 1] }] as Pot[] },
    );
    expect(totalPot(withPots)).toBe(300 + 200);
  });

  it('toCall is capped at the stack', () => {
    const s2 = state(
      [
        { seat: 0, stack: 900, currentBet: 100 },
        { seat: 1, stack: 30, currentBet: 0 },
      ],
      { round: createBettingRound(20, 100) },
    );
    expect(toCall(s2, 0)).toBe(0);
    expect(toCall(s2, 1)).toBe(30); // owes 100 but only has 30
  });
});

describe('isHandOver', () => {
  it('true when only one player still holds cards', () => {
    const s = state([
      { seat: 0, stack: 900, status: PlayerStatus.Active },
      { seat: 1, stack: 1000, status: PlayerStatus.Folded },
    ]);
    expect(isHandOver(s)).toBe(true);
  });

  it('true when the street is COMPLETE', () => {
    const s = state(
      [
        { seat: 0, stack: 900, status: PlayerStatus.Active },
        { seat: 1, stack: 900, status: PlayerStatus.Active },
      ],
      { street: Street.Complete },
    );
    expect(isHandOver(s)).toBe(true);
  });

  it('false mid-hand with multiple players in', () => {
    const s = state([
      { seat: 0, stack: 900, status: PlayerStatus.Active },
      { seat: 1, stack: 0, status: PlayerStatus.AllIn },
    ]);
    expect(isHandOver(s)).toBe(false);
  });
});

describe('nextActingSeat', () => {
  const s = state([
    { seat: 1, stack: 1000, status: PlayerStatus.Active },
    { seat: 3, stack: 1000, status: PlayerStatus.Folded },
    { seat: 5, stack: 1000, status: PlayerStatus.Active },
    { seat: 8, stack: 0, status: PlayerStatus.AllIn },
  ]);

  it('finds the next ACTIVE seat clockwise, skipping folded / all-in', () => {
    expect(nextActingSeat(s, 1)).toBe(5);
    expect(nextActingSeat(s, 5)).toBe(1); // wrap
    expect(nextActingSeat(s, 8)).toBe(1);
    expect(nextActingSeat(s, 2)).toBe(5);
  });

  it('returns null when nobody can act', () => {
    const allDone = state([
      { seat: 1, stack: 0, status: PlayerStatus.AllIn },
      { seat: 2, stack: 0, status: PlayerStatus.AllIn },
    ]);
    expect(nextActingSeat(allDone, 1)).toBeNull();
  });
});
