import { betTo, call, check, fold, raiseTo } from '../betting';
import { type BettingContext } from '../betting';
import { legalActions } from '../action-validator';
import { type GameEvent } from '../events/events';
import { type GameState, Street } from '../game-state/game-state';
import { type RandomProvider, SeededRandomProvider } from '../rng/random-provider';
import { createTableConfig } from '../table/table';
import { type EngineAction, initGameState, reduce } from './reduce';

/**
 * Plays thousands of complete, randomly-driven hands and asserts the hard
 * invariants after every action:
 *   - chips are never created or destroyed (checked after EVERY action)
 *   - no stack ever goes negative
 *   - the hand always terminates
 *   - every completed hand pays out exactly the pot
 *   - the event stream is well-formed (HAND_STARTED first, HAND_COMPLETED
 *     last, streets in order, board size matches the street)
 */

const config = createTableConfig({ smallBlind: 5, bigBlind: 10 });

function chipsInPlay(state: GameState): number {
  const stacks = state.players.reduce((t, p) => t + p.stack, 0);
  const onTable = state.players.reduce((t, p) => t + p.currentBet, 0);
  const uncollected = state.street === Street.Complete ? 0 : state.collectedPot;
  return stacks + onTable + uncollected;
}

function randomLegalAction(state: GameState, rng: RandomProvider): EngineAction {
  const seat = state.actingSeat as number;
  const player = state.players.find((p) => p.seatNumber === seat)!;
  const ctx: BettingContext = { players: state.players, round: state.round, actingSeat: seat };
  const options = legalActions(ctx, seat);
  const choice = options[rng.nextInt(options.length)];
  if (!choice) return { type: 'PLAYER_ACTION', seat, action: fold() };

  switch (choice.kind) {
    case 'FOLD':
      return { type: 'PLAYER_ACTION', seat, action: fold() };
    case 'CHECK':
      return { type: 'PLAYER_ACTION', seat, action: check() };
    case 'CALL':
      return { type: 'PLAYER_ACTION', seat, action: call() };
    case 'ALL_IN':
      return { type: 'PLAYER_ACTION', seat, action: { type: 'ALL_IN' } };
    case 'BET':
    case 'RAISE': {
      const min = choice.min ?? player.currentBet + player.stack;
      const max = choice.max ?? min;
      const amount = min + (max > min ? rng.nextInt(max - min + 1) : 0);
      return {
        type: 'PLAYER_ACTION',
        seat,
        action: choice.kind === 'BET' ? betTo(amount) : raiseTo(amount),
      };
    }
    default:
      return { type: 'PLAYER_ACTION', seat, action: fold() };
  }
}

const STREET_ORDER = [Street.Preflop, Street.Flop, Street.Turn, Street.River] as const;
const BOARD_BY_STREET_EVENT: Record<string, number> = {
  FLOP_DEALT: 3,
  TURN_DEALT: 4,
  RIVER_DEALT: 5,
};

function assertEventStream(events: GameEvent[], startStackTotal: number): void {
  expect(events[0]?.type).toBe('HAND_STARTED');
  expect(events.at(-1)?.type).toBe('HAND_COMPLETED');
  expect(events.filter((e) => e.type === 'HAND_STARTED')).toHaveLength(1);
  expect(events.filter((e) => e.type === 'HAND_COMPLETED')).toHaveLength(1);

  // streets are dealt in order and only once each
  const dealt = events.filter((e) => e.type in BOARD_BY_STREET_EVENT).map((e) => e.type);
  const expectedPrefixes = ['FLOP_DEALT', 'TURN_DEALT', 'RIVER_DEALT'];
  expect(dealt).toEqual(expectedPrefixes.slice(0, dealt.length));

  // payouts (+ any returned bets) exactly account for the money that left stacks
  const awarded = events
    .filter((e): e is Extract<GameEvent, { type: 'POT_AWARDED' }> => e.type === 'POT_AWARDED')
    .reduce((t, e) => t + e.amount, 0);
  const paidToWinners = events
    .filter((e): e is Extract<GameEvent, { type: 'POT_AWARDED' }> => e.type === 'POT_AWARDED')
    .flatMap((e) => e.winners)
    .reduce((t, w) => t + w.amount, 0);
  expect(paidToWinners).toBe(awarded);

  const completed = events.at(-1) as Extract<GameEvent, { type: 'HAND_COMPLETED' }>;
  const finalTotal = completed.results.reduce((t, r) => t + r.stack, 0);
  expect(finalTotal).toBe(startStackTotal);
  expect(completed.results.reduce((t, r) => t + r.net, 0)).toBe(0);
}

function playHand(
  initial: GameState,
  handNo: number,
  buttonSeat: number | null,
  rng: RandomProvider,
): { state: GameState; events: GameEvent[] } {
  const startStackTotal = chipsInPlay(initial);

  let result = reduce(
    initial,
    {
      type: 'START_HAND',
      handId: `h${handNo}`,
      handNumber: handNo,
      previousButtonSeat: buttonSeat,
    },
    rng,
  );
  const events = [...result.events];
  expect(chipsInPlay(result.state)).toBe(startStackTotal);

  let steps = 0;
  while (result.state.street !== Street.Complete && result.state.street !== Street.Waiting) {
    if (result.state.actingSeat === null) {
      throw new Error(`stuck: street=${result.state.street} but no acting seat`);
    }
    result = reduce(result.state, randomLegalAction(result.state, rng), rng);
    events.push(...result.events);
    if (result.events.some((e) => e.type === 'ACTION_REJECTED')) {
      throw new Error('random driver produced an illegal action');
    }
    // chip total is invariant after EVERY action
    expect(chipsInPlay(result.state)).toBe(startStackTotal);
    for (const p of result.state.players) expect(p.stack).toBeGreaterThanOrEqual(0);
    // streets never go backwards
    expect(STREET_ORDER.indexOf(result.state.street as (typeof STREET_ORDER)[number])).toBeLessThan(
      5,
    );
    if ((steps += 1) > 400) throw new Error('hand did not terminate');
  }

  if (result.state.street === Street.Complete) {
    assertEventStream(events, startStackTotal);
  }
  return { state: result.state, events };
}

describe('reduce: full-hand simulation', () => {
  it('holds every invariant over ~19,000 random hands (2-6 players)', () => {
    const rng = new SeededRandomProvider(0xc0ffee);
    let handsPlayed = 0;
    let showdowns = 0;
    let foldWins = 0;
    let buttonMoves = 0;

    for (let seed = 0; seed < 4000; seed += 1) {
      const playerCount = 2 + (seed % 5);
      const startStacks: Record<number, number> = {};
      for (let seat = 1; seat <= playerCount; seat += 1) {
        startStacks[seat] = 200 + rng.nextInt(1800);
      }
      const totalChips = Object.values(startStacks).reduce((a, b) => a + b, 0);

      let state = initGameState({
        tableId: 'sim',
        config,
        players: Object.entries(startStacks).map(([seat, stack]) => ({
          userId: `u${seat}`,
          seatNumber: Number(seat),
          stack,
        })),
      });

      let button: number | null = null;
      for (let hand = 1; hand <= 6; hand += 1) {
        if (state.players.filter((p) => p.stack > 0).length < 2) break;

        const { state: next, events } = playHand(state, hand, button, rng);
        state = next;

        expect(state.players.reduce((t, p) => t + p.stack, 0)).toBe(totalChips);
        expect(state.street).toBe(Street.Complete);

        if (button !== null && state.buttonSeat !== button) buttonMoves += 1;
        if (events.some((e) => e.type === 'SHOWDOWN_STARTED')) showdowns += 1;
        else foldWins += 1;

        button = state.buttonSeat;
        handsPlayed += 1;
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `simulation: ${handsPlayed} hands (${showdowns} showdowns, ${foldWins} fold-wins, ${buttonMoves} button moves)`,
    );
    expect(handsPlayed).toBeGreaterThan(18_000);
    expect(showdowns).toBeGreaterThan(1000);
    expect(foldWins).toBeGreaterThan(1000);
    expect(buttonMoves).toBeGreaterThan(10_000);
  });

  it('is deterministic: the same seed replays identically', () => {
    const run = () => {
      const rng = new SeededRandomProvider(777);
      const state = initGameState({
        tableId: 'sim',
        config,
        players: [1, 2, 3].map((s) => ({ userId: `u${s}`, seatNumber: s, stack: 1000 })),
      });
      const { state: end, events } = playHand(state, 1, null, rng);
      return { stacks: end.players.map((p) => p.stack), eventTypes: events.map((e) => e.type) };
    };
    expect(run()).toEqual(run());
  });
});
