import { betTo, call, check, fold, raiseTo, type BettingContext, potLimitMaxTo } from '../betting';
import { legalActions } from '../action-validator';
import { type GameEvent } from '../events/events';
import { type GameState, Street } from '../game-state/game-state';
import { type RandomProvider, SeededRandomProvider } from '../rng/random-provider';
import { createTableConfig, previousPositionsOf, type PreviousPositions } from '../table/table';
import { GameVariant } from '../variant/variant';
import { type EngineAction, initGameState, reduce } from './reduce';

/**
 * The Hold'em `simulation.test.ts` in this folder proves the core invariants.
 * This one does the same for four-card Pot-Limit Omaha, and additionally checks
 * the pot-limit ceiling: no bet or raise the engine accepts ever exceeds the
 * pot at the moment it was made.
 */

const config = createTableConfig({
  variant: GameVariant.Omaha,
  smallBlind: 5,
  bigBlind: 10,
  maxSeats: 6,
});

function potLimitCtx(state: GameState): BettingContext {
  return {
    players: state.players,
    round: state.round,
    actingSeat: state.actingSeat as number,
    potBeforeRound: state.collectedPot,
    bettingLimit: 'POT_LIMIT',
  };
}

function chipsInPlay(state: GameState): number {
  const onTable = state.players.reduce((t, p) => t + p.currentBet, 0);
  const uncollected = state.street === Street.Complete ? 0 : state.collectedPot;
  return state.players.reduce((t, p) => t + p.stack, 0) + onTable + uncollected;
}

function randomLegalAction(state: GameState, rng: RandomProvider): EngineAction {
  const seat = state.actingSeat as number;
  const ctx = potLimitCtx(state);
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
      const player = state.players.find((p) => p.seatNumber === seat)!;
      const min = choice.min ?? player.currentBet + player.stack;
      const max = choice.max ?? min;
      const amount = min + (max > min ? rng.nextInt(max - min + 1) : 0);
      // the option bounds must never exceed the pot-limit ceiling
      const stackTo = player.currentBet + player.stack;
      const cap = Math.min(stackTo, potLimitMaxTo(ctx, seat));
      expect(max).toBeLessThanOrEqual(cap);
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

function playHand(
  initial: GameState,
  handNo: number,
  previous: PreviousPositions | null,
  rng: RandomProvider,
): { state: GameState; events: GameEvent[] } {
  const startTotal = chipsInPlay(initial);
  let result = reduce(
    initial,
    { type: 'START_HAND', handId: `h${handNo}`, handNumber: handNo, previousPositions: previous },
    rng,
  );
  const events = [...result.events];

  for (const p of result.state.players) {
    if (p.status === 'ACTIVE' || p.status === 'ALL_IN') {
      expect(p.holeCards).toHaveLength(4);
    }
  }

  let steps = 0;
  while (result.state.street !== Street.Complete && result.state.street !== Street.Waiting) {
    if (result.state.actingSeat === null) {
      throw new Error(`stuck: street=${result.state.street} but no acting seat`);
    }
    // the pot never exceeds what pot-limit allows for the seat about to act
    const potCeil = potLimitMaxTo(potLimitCtx(result.state), result.state.actingSeat);
    result = reduce(result.state, randomLegalAction(result.state, rng), rng);
    events.push(...result.events);
    const lastAggro = result.events.find(
      (e) => e.type === 'PLAYER_BET' || e.type === 'PLAYER_RAISED',
    ) as { amount: number } | undefined;
    if (lastAggro) expect(lastAggro.amount).toBeLessThanOrEqual(potCeil);

    if (result.events.some((e) => e.type === 'ACTION_REJECTED')) {
      throw new Error(
        `random driver produced an illegal action: ${JSON.stringify(
          result.events.find((e) => e.type === 'ACTION_REJECTED'),
        )}`,
      );
    }
    expect(chipsInPlay(result.state)).toBe(startTotal);
    for (const p of result.state.players) expect(p.stack).toBeGreaterThanOrEqual(0);
    if ((steps += 1) > 400) throw new Error('hand did not terminate');
  }

  if (result.state.street === Street.Complete) {
    const completed = events.at(-1) as Extract<GameEvent, { type: 'HAND_COMPLETED' }>;
    expect(completed.type).toBe('HAND_COMPLETED');
    expect(completed.results.reduce((t, r) => t + r.stack, 0)).toBe(startTotal);
    expect(completed.results.reduce((t, r) => t + r.net, 0)).toBe(0);
  }
  return { state: result.state, events };
}

describe('Omaha full-hand simulation', () => {
  it('holds every invariant over thousands of random pot-limit hands', () => {
    const rng = new SeededRandomProvider(0x0a2a2a);
    let handsPlayed = 0;
    let showdowns = 0;

    for (let seed = 0; seed < 1500; seed += 1) {
      const playerCount = 2 + (seed % 5);
      const startStacks: Record<number, number> = {};
      for (let seat = 1; seat <= playerCount; seat += 1) {
        startStacks[seat] = 200 + rng.nextInt(1800);
      }
      const totalChips = Object.values(startStacks).reduce((a, b) => a + b, 0);

      let state = initGameState({
        tableId: 'omaha-sim',
        config,
        players: Object.entries(startStacks).map(([seat, stack]) => ({
          userId: `u${seat}`,
          seatNumber: Number(seat),
          stack,
        })),
      });

      let previous: PreviousPositions | null = null;
      for (let hand = 1; hand <= 4; hand += 1) {
        if (state.players.filter((p) => p.stack > 0).length < 2) break;
        const { state: next, events } = playHand(state, hand, previous, rng);
        state = next;
        expect(state.players.reduce((t, p) => t + p.stack, 0)).toBe(totalChips);
        expect(state.street).toBe(Street.Complete);
        if (events.some((e) => e.type === 'SHOWDOWN_STARTED')) showdowns += 1;
        previous = previousPositionsOf(state);
        handsPlayed += 1;
      }
    }

    expect(handsPlayed).toBeGreaterThan(4000);
    expect(showdowns).toBeGreaterThan(300);
  });
});
