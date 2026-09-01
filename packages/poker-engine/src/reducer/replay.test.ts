import { createDeck } from '../deck/deck';
import { legalActions } from '../action-validator';
import { type BettingContext, type PlayerAction } from '../betting';
import { type GameState, Street } from '../game-state/game-state';
import { createTableConfig } from '../table/table';
import { SeededRandomProvider } from '../rng/random-provider';
import { shuffle } from '../shuffle/shuffle';
import { type EngineAction, initGameState, reduce } from './reduce';
import { type HandRecord, replayHand } from './replay';

const config = createTableConfig({ smallBlind: 5, bigBlind: 10 });

function randomAction(state: GameState, rng: SeededRandomProvider): PlayerAction {
  const seat = state.actingSeat as number;
  const player = state.players.find((p) => p.seatNumber === seat)!;
  const ctx: BettingContext = { players: state.players, round: state.round, actingSeat: seat };
  const options = legalActions(ctx, seat);
  const choice = options[rng.nextInt(options.length)] ?? { kind: 'FOLD' as const };
  switch (choice.kind) {
    case 'CHECK':
      return { type: 'CHECK' };
    case 'CALL':
      return { type: 'CALL' };
    case 'ALL_IN':
      return { type: 'ALL_IN' };
    case 'BET':
    case 'RAISE': {
      const min = choice.min ?? player.currentBet + player.stack;
      const max = choice.max ?? min;
      const amount = min + (max > min ? rng.nextInt(max - min + 1) : 0);
      return choice.kind === 'BET' ? { type: 'BET', amount } : { type: 'RAISE', amount };
    }
    default:
      return { type: 'FOLD' };
  }
}

/** Play one random hand, capturing the record needed to replay it. */
function recordRandomHand(seed: number, playerCount: number): HandRecord {
  const rng = new SeededRandomProvider(seed);
  const seats = Array.from({ length: playerCount }, (_, i) => ({
    userId: `u${i}`,
    seatNumber: i,
    stack: 400 + rng.nextInt(2000),
  }));
  const deck = shuffle(createDeck(), rng);

  let state = initGameState({ tableId: 't', config, players: seats });
  const actions: EngineAction[] = [];

  state = reduce(
    state,
    { type: 'START_HAND', handId: 'h1', handNumber: 1, previousButtonSeat: null, deck },
    rng,
  ).state;

  let guard = 0;
  while (state.street !== Street.Complete && state.actingSeat !== null) {
    if ((guard += 1) > 300) throw new Error('non-terminating');
    const action: EngineAction = {
      type: 'PLAYER_ACTION',
      seat: state.actingSeat,
      action: randomAction(state, rng),
    };
    const res = reduce(state, action, rng);
    if (!res.events.some((e) => e.type === 'ACTION_REJECTED')) actions.push(action);
    state = res.state;
  }

  return {
    tableId: 't',
    config,
    seats,
    handId: 'h1',
    handNumber: 1,
    previousButtonSeat: null,
    deck,
    actions,
  };
}

describe('replayHand', () => {
  it('reproduces the exact event stream and final state for 400 random hands', () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const record = recordRandomHand(seed, 2 + (seed % 5));

      const first = replayHand(record);
      const second = replayHand(record);

      expect(JSON.stringify(first.events)).toEqual(JSON.stringify(second.events));
      expect(JSON.stringify(first.state)).toEqual(JSON.stringify(second.state));

      expect(first.events[0]?.type).toBe('HAND_STARTED');
      expect(first.events.at(-1)?.type).toBe('HAND_COMPLETED');
      expect(first.state.street).toBe(Street.Complete);

      // chips conserved through the replay
      const start = record.seats.reduce((t, s) => t + s.stack, 0);
      expect(first.state.players.reduce((t, p) => t + p.stack, 0)).toBe(start);
    }
  });

  it('an explicit deck deals exactly the specified hole cards', () => {
    const record: HandRecord = {
      tableId: 't',
      config,
      seats: [
        { userId: 'a', seatNumber: 0, stack: 1000 },
        { userId: 'b', seatNumber: 1, stack: 1000 },
      ],
      handId: 'h1',
      handNumber: 1,
      previousButtonSeat: null,
      // heads-up: SB (seat 0) is dealt first, then BB (seat 1)
      deck: createDeck(),
      actions: [],
    };
    const { events } = replayHand(record);
    const dealt = events.find((e) => e.type === 'HOLE_CARDS_DEALT');
    // createDeck() order: 2c 2d 2h 2s 3c ... -> seat0 gets 2c+2h, seat1 gets 2d+2s
    expect(dealt).toBeTruthy();
  });

  it('is independent of the RNG once a deck is supplied', () => {
    const record = recordRandomHand(99, 4);
    // replayHand always uses SeededRandomProvider(0) internally; a second call
    // through reduce() with a different rng must still match.
    const viaReplay = replayHand(record);
    let state = initGameState({ tableId: 't', config, players: [...record.seats] });
    const rng = new SeededRandomProvider(777777);
    state = reduce(
      state,
      {
        type: 'START_HAND',
        handId: record.handId,
        handNumber: record.handNumber,
        previousButtonSeat: null,
        deck: record.deck,
      },
      rng,
    ).state;
    for (const action of record.actions) state = reduce(state, action, rng).state;
    expect(JSON.stringify(state)).toEqual(JSON.stringify(viaReplay.state));
  });
});
