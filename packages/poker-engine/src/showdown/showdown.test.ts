import { parseCards } from '../cards/card';
import { createBettingRound } from '../betting/betting';
import { freshDeck } from '../deck/deck';
import { HandCategory } from '../hand-evaluator/hand-rank';
import { type GameState, Street } from '../game-state/game-state';
import { createPlayer, type PlayerState, PlayerStatus } from '../player/player';
import { createTableConfig } from '../table/table';
import { evaluateShowdown, showdownOrder, summarizeHand } from './showdown';

const withCards = (seat: number, cards: string, status = PlayerStatus.Active): PlayerState => ({
  ...createPlayer(`u${seat}`, seat, 1000),
  status,
  holeCards: parseCards(cards),
});

const state = (
  players: PlayerState[],
  community: string,
  overrides: Partial<GameState> = {},
): GameState => ({
  tableId: 't',
  handId: 'h',
  handNumber: 1,
  config: createTableConfig({ bigBlind: 20 }),
  street: Street.River,
  buttonSeat: 1,
  smallBlindSeat: 2,
  bigBlindSeat: 3,
  communityCards: parseCards(community),
  players: [...players].sort((a, b) => a.seatNumber - b.seatNumber),
  actingSeat: null,
  round: createBettingRound(20, 0),
  deck: freshDeck(),
  collectedPot: 0,
  pots: [],
  actionDeadline: null,
  ...overrides,
});

describe('showdownOrder', () => {
  it('starts with the last river aggressor, then clockwise', () => {
    const s = state(
      [withCards(1, 'Ah Kh'), withCards(3, 'Td Tc'), withCards(5, '7d 7c')],
      '9h 8h 7h 6c 2s',
      { round: { currentBet: 100, lastRaiseSize: 100, lastAggressorSeat: 3, minOpen: 20 } },
    );
    expect(showdownOrder(s)).toEqual([3, 5, 1]);
  });

  it('when the river checked through, starts left of the button', () => {
    const s = state(
      [withCards(1, 'Ah Kh'), withCards(3, 'Td Tc'), withCards(5, '7d 7c')],
      '9h 8h 7h 6c 2s',
      {
        buttonSeat: 1,
        round: { currentBet: 0, lastRaiseSize: 20, lastAggressorSeat: null, minOpen: 20 },
      },
    );
    expect(showdownOrder(s)).toEqual([3, 5, 1]);
  });

  it('excludes folded players', () => {
    const s = state(
      [withCards(1, 'Ah Kh'), withCards(3, 'Qd Qc', PlayerStatus.Folded), withCards(5, '7s 2d')],
      '9h 8h 7h 6c 2s',
    );
    expect(showdownOrder(s)).toEqual([5, 1]);
  });
});

describe('evaluateShowdown', () => {
  it('evaluates every contesting player against the board', () => {
    const s = state(
      [withCards(1, 'Ah Kh'), withCards(3, 'Td Tc'), withCards(5, '7d 7c')],
      '9h 8h 7h 6c 2s',
    );
    const ranks = evaluateShowdown(s);
    expect(ranks.get(1)?.category).toBe(HandCategory.Flush); // Ah Kh + 9h 8h 7h
    expect(ranks.get(3)?.category).toBe(HandCategory.Straight); // Td Tc + 9-8-7-6 -> T-high straight
    expect(ranks.get(5)?.category).toBe(HandCategory.ThreeOfAKind); // 7d 7c + 7h
  });

  it('omits folded players', () => {
    const s = state(
      [withCards(1, 'Ah Kh'), withCards(3, 'Qd Qc', PlayerStatus.Folded)],
      '9h 8h 7h 6c 2s',
    );
    expect(evaluateShowdown(s).has(3)).toBe(false);
  });
});

describe('summarizeHand', () => {
  it('carries a serializable, described summary', () => {
    const s = state([withCards(1, 'Ah Kh')], '9h 8h 7h 6c 2s');
    const summary = summarizeHand(evaluateShowdown(s).get(1)!);
    expect(summary).toMatchObject({ category: HandCategory.Flush, description: 'Flush, Ace high' });
    expect(summary.cards).toHaveLength(5);
  });
});
