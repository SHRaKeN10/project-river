import { SeededRandomProvider } from '../rng/random-provider';
import { createTableConfig } from '../table/table';
import { Street } from '../game-state/game-state';
import { type EngineAction, initGameState, reduce, type ReduceResult } from './reduce';

/**
 * The randomized `simulation.test.ts` only ever drives *legal* actions. This
 * suite does the opposite: it fires deliberately malformed / hostile
 * `EngineAction`s at `reduce` and asserts it is genuinely total - it never
 * throws, never mutates the input, and either advances legally or emits exactly
 * one ACTION_REJECTED with the state left byte-identical.
 */

const config = createTableConfig({ smallBlind: 5, bigBlind: 10 });

function garbageAction(rng: SeededRandomProvider, seatPool: number[]): EngineAction {
  const seat =
    rng.nextInt(10) === 0
      ? rng.nextInt(999) - 100 // wild seat number
      : (seatPool[rng.nextInt(seatPool.length)] as number);
  const amt = (): number =>
    [NaN, Infinity, -Infinity, 33.7, 0, -50, rng.nextInt(5000) - 1000][rng.nextInt(7)] as number;

  const kinds: (() => EngineAction)[] = [
    () => ({ type: 'PLAYER_ACTION', seat, action: { type: 'FOLD' } }),
    () => ({ type: 'PLAYER_ACTION', seat, action: { type: 'CHECK' } }),
    () => ({ type: 'PLAYER_ACTION', seat, action: { type: 'CALL' } }),
    () => ({ type: 'PLAYER_ACTION', seat, action: { type: 'BET', amount: amt() } }),
    () => ({ type: 'PLAYER_ACTION', seat, action: { type: 'RAISE', amount: amt() } }),
    () => ({ type: 'PLAYER_ACTION', seat, action: { type: 'ALL_IN' } }),
    () => ({ type: 'PLAYER_ACTION', seat, action: { type: 'WAT' } as never }),
    () => ({ type: 'TIMEOUT', seat }),
    () => ({ type: 'SIT_OUT', seat }),
    () => ({ type: 'RETURN', seat }),
    () => ({
      type: 'START_HAND',
      handId: 'dup',
      handNumber: rng.nextInt(3),
      previousPositions: null,
    }),
    () => ({ type: 'NONSENSE' }) as unknown as EngineAction,
    () => ({}) as unknown as EngineAction,
  ];
  return kinds[rng.nextInt(kinds.length)]!();
}

describe('reduce is total under malformed input', () => {
  it('never throws and never mutates state over ~20k random garbage actions', () => {
    const rng = new SeededRandomProvider(0xbadbeef);

    for (let seed = 0; seed < 2000; seed += 1) {
      const playerCount = 2 + (seed % 5);
      const seatPool = Array.from({ length: playerCount }, (_, i) => i + 1);
      let state = initGameState({
        tableId: 'fuzz',
        config,
        players: seatPool.map((s) => ({
          userId: `u${s}`,
          seatNumber: s,
          stack: 400 + rng.nextInt(1600),
        })),
      });
      const startChips = state.players.reduce((t, p) => t + p.stack, 0);

      // legitimately start a hand first roughly half the time
      if (seed % 2 === 0) {
        state = reduce(
          state,
          { type: 'START_HAND', handId: `h${seed}`, handNumber: 1, previousPositions: null },
          rng,
        ).state;
      }

      for (let step = 0; step < 10; step += 1) {
        const action = garbageAction(rng, seatPool);
        const before = JSON.stringify(state);

        let result: ReduceResult;
        try {
          result = reduce(state, action, rng);
        } catch (err) {
          throw new Error(`reduce threw on ${JSON.stringify(action)}: ${(err as Error).message}`);
        }

        // the input object is never mutated
        expect(JSON.stringify(state)).toBe(before);

        if (result.events.some((e) => e.type === 'ACTION_REJECTED')) {
          expect(JSON.stringify(result.state)).toBe(before);
        }

        state = result.state;

        const chips =
          state.players.reduce((t, p) => t + p.stack + p.currentBet, 0) +
          (state.street === Street.Complete ? 0 : state.collectedPot);
        expect(chips).toBe(startChips);
        for (const p of state.players) expect(p.stack).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
