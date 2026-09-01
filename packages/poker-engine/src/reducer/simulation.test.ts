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
 *   - chips are never created or destroyed
 *   - no player's stack goes negative
 *   - the hand always terminates
 *   - every completed hand pays out exactly the pot
 */

const config = createTableConfig({ smallBlind: 5, bigBlind: 10 });

function randomLegalAction(state: GameState, rng: RandomProvider): EngineAction {
  const seat = state.actingSeat;
  if (seat === null) throw new Error('no acting seat');
  const player = state.players.find((p) => p.seatNumber === seat);
  if (!player) throw new Error('acting seat has no player');

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

function playHand(
  initial: GameState,
  handNo: number,
  buttonSeat: number | null,
  rng: RandomProvider,
): { state: GameState; events: GameEvent[] } {
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
    if ((steps += 1) > 400) throw new Error('hand did not terminate');
  }
  return { state: result.state, events };
}

describe('reduce: full-hand simulation', () => {
  it('preserves chip totals over 3000 random hands (2-6 players)', () => {
    const rng = new SeededRandomProvider(0xc0ffee);
    let handsPlayed = 0;
    let showdowns = 0;
    let foldWins = 0;

    for (let seed = 0; seed < 3000; seed += 1) {
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
        const funded = state.players.filter((p) => p.stack > 0).length;
        if (funded < 2) break;

        const { state: next, events } = playHand(state, hand, button, rng);
        state = next;

        // hard invariants
        expect(state.players.reduce((t, p) => t + p.stack, 0)).toBe(totalChips);
        for (const p of state.players) expect(p.stack).toBeGreaterThanOrEqual(0);
        expect(state.street).toBe(Street.Complete);

        const potAwards = events.filter((e) => e.type === 'POT_AWARDED');
        const paid = potAwards
          .flatMap((e) => (e.type === 'POT_AWARDED' ? e.winners : []))
          .reduce((t, w) => t + w.amount, 0);
        const potFromEvents = potAwards.reduce(
          (t, e) => t + (e.type === 'POT_AWARDED' ? e.amount : 0),
          0,
        );
        expect(paid).toBe(potFromEvents);

        if (events.some((e) => e.type === 'SHOWDOWN_STARTED')) showdowns += 1;
        else foldWins += 1;

        button = state.buttonSeat;
        handsPlayed += 1;
      }
    }

    // eslint-disable-next-line no-console
    console.log(`simulation: ${handsPlayed} hands (${showdowns} showdowns, ${foldWins} fold-wins)`);
    expect(handsPlayed).toBeGreaterThan(3000);
    expect(showdowns).toBeGreaterThan(0);
    expect(foldWins).toBeGreaterThan(0);
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
