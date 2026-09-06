import { type Card } from '../cards/card';
import { type PlayerAction } from '../betting';
import { type GameEvent } from '../events/events';
import { type GameState, Street } from '../game-state/game-state';
import { type EngineAction, initGameState, type ReduceResult, reduce } from '../reducer/reduce';
import { SeededRandomProvider } from '../rng/random-provider';
import {
  assignPositions,
  previousPositionsOf,
  type PreviousPositions,
  seatsForNextHand,
  type TableConfig,
} from '../table/table';

export interface Seat {
  userId: string;
  seatNumber: number;
  stack: number;
}

/** Thin test harness around `reduce` - tracks state + the full event log,
 * plus chip accounting so every test can assert conservation. */
export class HandRunner {
  state: GameState;
  events: GameEvent[] = [];
  lastEvents: GameEvent[] = [];
  actionsThisHand: EngineAction[] = [];

  private readonly rng = new SeededRandomProvider(12345);
  private handNo = 0;
  private previousPositions: PreviousPositions | null = null;

  constructor(
    readonly config: TableConfig,
    readonly seats: Seat[],
  ) {
    this.state = initGameState({ tableId: 'test', config, players: seats });
  }

  /** Deal order `dealHoleCards` will use for the *next* hand (SB first). */
  nextDealOrder(): number[] {
    const eligible = seatsForNextHand(this.state.players);
    const positions = assignPositions(eligible, this.previousPositions, this.config.maxSeats);
    const sorted = [...eligible].sort((a, b) => a - b);
    const anchor = positions.smallBlindSeat ?? positions.bigBlindSeat;
    const idx = sorted.findIndex((s) => s >= anchor);
    const pivot = idx === -1 ? 0 : idx;
    return [...sorted.slice(pivot), ...sorted.slice(0, pivot)];
  }

  /** Positions for the next hand (button/blinds/first-to-act). */
  nextPositions() {
    return assignPositions(
      seatsForNextHand(this.state.players),
      this.previousPositions,
      this.config.maxSeats,
    );
  }

  startHand(deck?: readonly Card[], bombPot?: { amount: number }): ReduceResult {
    this.handNo += 1;
    this.actionsThisHand = [];
    return this.dispatch({
      type: 'START_HAND',
      handId: `h${this.handNo}`,
      handNumber: this.handNo,
      previousPositions: this.previousPositions,
      deck,
      ...(bombPot ? { bombPot } : {}),
    });
  }

  act(seat: number, action: PlayerAction): ReduceResult {
    return this.dispatch({ type: 'PLAYER_ACTION', seat, action });
  }

  timeout(seat: number): ReduceResult {
    return this.dispatch({ type: 'TIMEOUT', seat });
  }

  dispatch(action: EngineAction): ReduceResult {
    const result = reduce(this.state, action, this.rng);
    this.state = result.state;
    this.lastEvents = result.events;
    this.events.push(...result.events);
    if (action.type !== 'START_HAND') this.actionsThisHand.push(action);
    if (this.state.street === Street.Complete) {
      this.previousPositions = previousPositionsOf(this.state);
    }
    return result;
  }

  /** Auto-play the current hand to completion by having the acting player
   * check, else call, else fold. Returns the number of actions taken. */
  autoFinish(maxSteps = 200): number {
    let steps = 0;
    while (this.state.street !== Street.Complete && this.state.actingSeat !== null) {
      if ((steps += 1) > maxSteps) throw new Error('hand did not terminate');
      const seat = this.state.actingSeat;
      const owed = this.toCall(seat);
      this.act(seat, owed === 0 ? { type: 'CHECK' } : { type: 'CALL' });
    }
    return steps;
  }

  toCall(seat: number): number {
    const player = this.state.players.find((p) => p.seatNumber === seat);
    if (!player) return 0;
    return Math.max(0, this.state.round.currentBet - player.currentBet);
  }

  stackOf(seat: number): number {
    return this.state.players.find((p) => p.seatNumber === seat)?.stack ?? 0;
  }

  totalStacks(): number {
    return this.state.players.reduce((t, p) => t + p.stack, 0);
  }

  /** Chips currently in the system - invariant across a whole hand. */
  chips(): number {
    const onTable = this.state.players.reduce((t, p) => t + p.currentBet, 0);
    const uncollected = this.state.street === Street.Complete ? 0 : this.state.collectedPot;
    return this.totalStacks() + onTable + uncollected;
  }

  eventTypes(events: GameEvent[] = this.events): string[] {
    return events.map((e) => e.type);
  }

  potAwards(): { seat: number; amount: number }[] {
    return this.events
      .filter((e): e is Extract<GameEvent, { type: 'POT_AWARDED' }> => e.type === 'POT_AWARDED')
      .flatMap((e) => e.winners.map((w) => ({ seat: w.seat, amount: w.amount })));
  }

  payoutOf(seat: number): number {
    return this.potAwards()
      .filter((w) => w.seat === seat)
      .reduce((t, w) => t + w.amount, 0);
  }
}
