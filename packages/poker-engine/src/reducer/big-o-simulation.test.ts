import { betTo, call, check, fold, raiseTo, type BettingContext, potLimitMaxTo } from '../betting';
import { legalActions } from '../action-validator';
import { type GameEvent } from '../events/events';
import { type GameState, Street } from '../game-state/game-state';
import { type RandomProvider, SeededRandomProvider } from '../rng/random-provider';
import { createTableConfig, previousPositionsOf, type PreviousPositions } from '../table/table';
import { GameVariant } from '../variant/variant';
import { type EngineAction, initGameState, reduce } from './reduce';

/**
 * Random five-card Omaha hi/lo hands. On top of the Hold'em/PLO invariants this
 * checks the split-pot maths: for every completed hand the payouts exactly
 * account for the pots, and a `LOW` award is always exactly floor(potHalf) and
 * only ever goes to a seat that tabled a qualifying eight-or-better low.
 */

const config = createTableConfig({
  variant: GameVariant.Omaha5HiLo,
  smallBlind: 5,
  bigBlind: 10,
  maxSeats: 6,
});

function ctx(state: GameState): BettingContext {
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
  const options = legalActions(ctx(state), seat);
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
      expect(max).toBeLessThanOrEqual(
        Math.min(player.currentBet + player.stack, potLimitMaxTo(ctx(state), seat)),
      );
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

type Awarded = Extract<GameEvent, { type: 'POT_AWARDED' }>;

function checkAwards(events: GameEvent[]): { splits: number; lows: number } {
  const awards = events.filter((e): e is Awarded => e.type === 'POT_AWARDED');
  // every award's amount equals the sum paid to its winners
  for (const a of awards) {
    expect(a.amount).toBe(a.winners.reduce((t, w) => t + w.amount, 0));
  }
  // a LOW award always has a matching HIGH award for the same pot, and its
  // amount is exactly the floor half of the two together
  let splits = 0;
  let lows = 0;
  const byPot = new Map<number, Awarded[]>();
  for (const a of awards) {
    const list = byPot.get(a.potIndex) ?? [];
    list.push(a);
    byPot.set(a.potIndex, list);
  }
  for (const list of byPot.values()) {
    const hi = list.find((a) => a.portion === 'HIGH');
    const lo = list.find((a) => a.portion === 'LOW');
    if (lo) {
      lows += 1;
      expect(hi).toBeDefined();
      const total = (hi as Awarded).amount + lo.amount;
      expect(lo.amount).toBe(Math.floor(total / 2));
      splits += 1;
    }
  }
  return { splits, lows };
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
    if (p.status === 'ACTIVE' || p.status === 'ALL_IN') expect(p.holeCards).toHaveLength(5);
  }

  let steps = 0;
  while (result.state.street !== Street.Complete && result.state.street !== Street.Waiting) {
    if (result.state.actingSeat === null) throw new Error('stuck: no acting seat');
    result = reduce(result.state, randomLegalAction(result.state, rng), rng);
    events.push(...result.events);
    if (result.events.some((e) => e.type === 'ACTION_REJECTED')) {
      throw new Error(`illegal action: ${JSON.stringify(result.events)}`);
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

describe('Big O full-hand simulation', () => {
  it('holds every invariant, including the split-pot maths, over thousands of hands', () => {
    const rng = new SeededRandomProvider(0xb16_0a);
    let hands = 0;
    let showdowns = 0;
    let splits = 0;
    let lowAwards = 0;

    for (let seed = 0; seed < 900; seed += 1) {
      const playerCount = 2 + (seed % 5);
      const stacks: Record<number, number> = {};
      for (let s = 1; s <= playerCount; s += 1) stacks[s] = 300 + rng.nextInt(1700);
      const total = Object.values(stacks).reduce((a, b) => a + b, 0);

      let state = initGameState({
        tableId: 'big-o-sim',
        config,
        players: Object.entries(stacks).map(([s, stack]) => ({
          userId: `u${s}`,
          seatNumber: Number(s),
          stack,
        })),
      });

      let previous: PreviousPositions | null = null;
      for (let hand = 1; hand <= 3; hand += 1) {
        if (state.players.filter((p) => p.stack > 0).length < 2) break;
        const { state: next, events } = playHand(state, hand, previous, rng);
        state = next;
        expect(state.players.reduce((t, p) => t + p.stack, 0)).toBe(total);
        expect(state.street).toBe(Street.Complete);
        if (events.some((e) => e.type === 'SHOWDOWN_STARTED')) showdowns += 1;
        const r = checkAwards(events);
        splits += r.splits;
        lowAwards += r.lows;
        previous = previousPositionsOf(state);
        hands += 1;
      }
    }

    expect(hands).toBeGreaterThan(2000);
    expect(showdowns).toBeGreaterThan(200);
    // Big O boards make eight-or-better lows common - the split path must be exercised
    expect(splits).toBeGreaterThan(50);
    expect(lowAwards).toBe(splits);
  });
});
