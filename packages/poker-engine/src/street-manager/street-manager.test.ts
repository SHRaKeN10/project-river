import { allDistinct, cardId } from '../cards/card';
import { createBettingRound } from '../betting/betting';
import { type GameState, Street } from '../game-state/game-state';
import { createPlayer, type PlayerState, PlayerStatus } from '../player/player';
import { SeededRandomProvider } from '../rng/random-provider';
import { shuffledDeck } from '../shuffle/shuffle';
import { createTableConfig } from '../table/table';
import {
  dealFlop,
  dealHoleCards,
  dealOrder,
  dealRiver,
  dealTurn,
  nextStreet,
  shouldRunOut,
} from './street-manager';

const p = (seat: number, status = PlayerStatus.Active): PlayerState => ({
  ...createPlayer(`u${seat}`, seat, 1000),
  status,
});

const baseState = (seats: PlayerState[], overrides: Partial<GameState> = {}): GameState => ({
  tableId: 't',
  handId: 'h',
  handNumber: 1,
  config: createTableConfig({ bigBlind: 20 }),
  street: Street.Preflop,
  buttonSeat: seats[0]?.seatNumber ?? 0,
  smallBlindSeat: seats[1]?.seatNumber ?? seats[0]?.seatNumber ?? 0,
  bigBlindSeat: seats[2]?.seatNumber ?? seats[0]?.seatNumber ?? 0,
  communityCards: [],
  secondBoard: [],
  runItTwice: false,
  players: [...seats].sort((a, b) => a.seatNumber - b.seatNumber),
  actingSeat: null,
  round: createBettingRound(20, 20),
  deck: shuffledDeck(new SeededRandomProvider(1)),
  collectedPot: 0,
  pots: [],
  actionDeadline: null,
  ...overrides,
});

describe('nextStreet', () => {
  it('walks the streets in order and stops at showdown', () => {
    expect(nextStreet(Street.Waiting)).toBe(Street.Preflop);
    expect(nextStreet(Street.Preflop)).toBe(Street.Flop);
    expect(nextStreet(Street.Flop)).toBe(Street.Turn);
    expect(nextStreet(Street.Turn)).toBe(Street.River);
    expect(nextStreet(Street.River)).toBe(Street.Showdown);
    expect(nextStreet(Street.Showdown)).toBe(Street.Showdown);
    expect(nextStreet(Street.Complete)).toBe(Street.Complete);
  });
});

describe('dealOrder', () => {
  it('starts at the small blind and goes clockwise', () => {
    const state = baseState([p(1), p(3), p(5), p(8)], { smallBlindSeat: 3 });
    expect(dealOrder(state)).toEqual([3, 5, 8, 1]);
  });

  it('skips folded / sitting-out seats', () => {
    const state = baseState(
      [p(1), p(3, PlayerStatus.Folded), p(5), p(8, PlayerStatus.SittingOut)],
      {
        smallBlindSeat: 1,
      },
    );
    expect(dealOrder(state)).toEqual([1, 5]);
  });
});

describe('dealHoleCards', () => {
  it('gives every player two distinct cards and advances the deck by 2 per player', () => {
    const state = baseState([p(2), p(4), p(6)], { smallBlindSeat: 4 });
    const { state: dealt, hands } = dealHoleCards(state);

    expect(hands).toHaveLength(3);
    for (const hand of hands) expect(hand.cards).toHaveLength(2);

    const all = hands.flatMap((h) => h.cards);
    expect(allDistinct(all)).toBe(true);
    expect(dealt.deck.cursor).toBe(6);

    for (const player of dealt.players) {
      expect(player.holeCards).toHaveLength(2);
    }
  });

  it('deals one card at a time, twice around (card 1 and card 4 to the first player)', () => {
    const state = baseState([p(1), p(2), p(3)], { smallBlindSeat: 1 });
    const order = state.deck.cards;
    const { hands } = dealHoleCards(state);
    const first = hands.find((h) => h.seat === 1);
    expect(first?.cards.map(cardId)).toEqual([cardId(order[0]!), cardId(order[3]!)]);
  });
});

describe('community cards', () => {
  it('flop burns one and deals three; turn and river burn one and deal one', () => {
    let state = baseState([p(1), p(2)]);
    const startCursor = state.deck.cursor;

    const flop = dealFlop(state);
    expect(flop.cards).toHaveLength(3);
    expect(flop.state.communityCards).toHaveLength(3);
    expect(flop.state.deck.cursor).toBe(startCursor + 4); // 1 burn + 3

    state = { ...flop.state, street: Street.Turn };
    const turn = dealTurn(state);
    expect(turn.state.communityCards).toHaveLength(4);
    expect(turn.state.deck.cursor).toBe(startCursor + 6);

    state = { ...turn.state, street: Street.River };
    const river = dealRiver(state);
    expect(river.state.communityCards).toHaveLength(5);
    expect(river.state.deck.cursor).toBe(startCursor + 8);
    expect(allDistinct([...river.state.communityCards])).toBe(true);
  });
});

describe('shouldRunOut', () => {
  it('true when 2+ hold cards but at most one can still act', () => {
    expect(
      shouldRunOut([p(1, PlayerStatus.AllIn), p(2, PlayerStatus.AllIn), p(3, PlayerStatus.Folded)]),
    ).toBe(true);
    expect(shouldRunOut([p(1, PlayerStatus.Active), p(2, PlayerStatus.AllIn)])).toBe(true);
  });

  it('false while two or more can act', () => {
    expect(shouldRunOut([p(1, PlayerStatus.Active), p(2, PlayerStatus.Active)])).toBe(false);
  });

  it('false when the hand is already down to one', () => {
    expect(shouldRunOut([p(1, PlayerStatus.AllIn), p(2, PlayerStatus.Folded)])).toBe(false);
  });
});
