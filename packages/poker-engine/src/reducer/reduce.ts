import { type Card } from '../cards/card';
import { deckFromCards, freshDeck } from '../deck/deck';
import {
  type BettingContext,
  betTo,
  call as callAction,
  check as checkAction,
  createBettingRound,
  fold as foldAction,
  isBettingRoundComplete,
  type PlayerAction,
  raiseTo,
} from '../betting';
import {
  amountToCall,
  applyBet,
  applyCall,
  applyCheck,
  applyFold,
  applyRaise,
} from '../betting/betting';
import { type GameEvent } from '../events/events';
import {
  contestingPlayers,
  type GameState,
  getPlayer,
  nextActingSeat,
  Street,
} from '../game-state/game-state';
import {
  awardPots,
  buildPots,
  type Contribution,
  returnUncalledBet,
} from '../pot-manager/pot-manager';
import {
  canAct,
  commitChips,
  type PlayerState,
  PlayerActionType,
  PlayerStatus,
  resetForHand,
  resetForStreet,
} from '../player/player';
import { type RandomProvider } from '../rng/random-provider';
import { evaluateShowdown, showdownOrder, summarizeHand } from '../showdown/showdown';
import {
  dealFlop,
  dealRiver,
  dealTurn,
  dealHoleCards,
  nextStreet,
  shouldRunOut,
} from '../street-manager/street-manager';
import {
  assignPositions,
  firstToActPostflop,
  type TableConfig,
  seatsForNextHand,
} from '../table/table';
import { shuffledDeck } from '../shuffle/shuffle';
import { validateAction, ValidationCode } from '../action-validator/action-validator';

export type EngineAction =
  | {
      readonly type: 'START_HAND';
      readonly handId: string;
      readonly handNumber: number;
      readonly previousButtonSeat: number | null;
      /**
       * Optional explicit 52-card deal order. When omitted, `rng` shuffles a
       * fresh deck. Supplying it makes a hand fully reproducible - the
       * application persists `{ deck, actions[] }` and `replayHand` re-runs it.
       */
      readonly deck?: readonly Card[];
    }
  | { readonly type: 'PLAYER_ACTION'; readonly seat: number; readonly action: PlayerAction }
  | { readonly type: 'TIMEOUT'; readonly seat: number }
  | { readonly type: 'SIT_OUT'; readonly seat: number }
  | { readonly type: 'RETURN'; readonly seat: number };

export interface ReduceResult {
  readonly state: GameState;
  readonly events: GameEvent[];
}

/** Creates an idle table state ready for the first `START_HAND`. */
export function initGameState(params: {
  tableId: string;
  config: TableConfig;
  players: readonly { userId: string; seatNumber: number; stack: number }[];
}): GameState {
  return {
    tableId: params.tableId,
    handId: '',
    handNumber: 0,
    config: params.config,
    street: Street.Waiting,
    buttonSeat: -1,
    smallBlindSeat: -1,
    bigBlindSeat: -1,
    communityCards: [],
    players: [...params.players]
      .sort((a, b) => a.seatNumber - b.seatNumber)
      .map((p) => ({
        userId: p.userId,
        seatNumber: p.seatNumber,
        stack: p.stack,
        currentBet: 0,
        totalInvested: 0,
        holeCards: [],
        status: p.stack > 0 ? PlayerStatus.Waiting : PlayerStatus.SittingOut,
        isDealer: false,
        isSmallBlind: false,
        isBigBlind: false,
        lastAction: null,
        hasActed: false,
      })),
    actingSeat: null,
    round: createBettingRound(params.config.bigBlind, 0),
    deck: freshDeck(),
    collectedPot: 0,
    pots: [],
    actionDeadline: null,
  };
}

/**
 * The single authoritative transition function. Pure and total: it never
 * throws on a player action - an illegal action yields an `ACTION_REJECTED`
 * event and the state unchanged. All randomness comes through `rng`.
 */
export function reduce(state: GameState, action: EngineAction, rng: RandomProvider): ReduceResult {
  switch (action.type) {
    case 'START_HAND':
      return startHand(state, action, rng);
    case 'PLAYER_ACTION':
      return applyPlayerAction(state, action.seat, action.action, rng);
    case 'TIMEOUT':
      return applyTimeout(state, action.seat, rng);
    case 'SIT_OUT':
      return setStatus(state, action.seat, PlayerStatus.SittingOut);
    case 'RETURN':
      return setStatus(state, action.seat, PlayerStatus.Waiting);
    default: {
      const exhaustive: never = action;
      return {
        state,
        events: [
          { type: 'ACTION_REJECTED', seat: -1, code: 'UNKNOWN', reason: String(exhaustive) },
        ],
      };
    }
  }
}

// ---------------------------------------------------------------------------
// START_HAND
// ---------------------------------------------------------------------------

function startHand(
  state: GameState,
  action: Extract<EngineAction, { type: 'START_HAND' }>,
  rng: RandomProvider,
): ReduceResult {
  if (state.street !== Street.Waiting && state.street !== Street.Complete) {
    return reject(state, -1, 'HAND_IN_PROGRESS', 'a hand is already in progress');
  }

  const reset = state.players.map(resetForHand);
  const seats = seatsForNextHand(reset);
  if (seats.length < 2) {
    return { state: { ...state, players: reset, street: Street.Waiting }, events: [] };
  }

  const positions = assignPositions(seats, action.previousButtonSeat);
  const { config } = state;

  const players: PlayerState[] = reset.map((p) => ({
    ...p,
    isDealer: p.seatNumber === positions.buttonSeat,
    isSmallBlind: p.seatNumber === positions.smallBlindSeat,
    isBigBlind: p.seatNumber === positions.bigBlindSeat,
  }));

  let working: GameState = {
    ...state,
    handId: action.handId,
    handNumber: action.handNumber,
    street: Street.Preflop,
    buttonSeat: positions.buttonSeat,
    smallBlindSeat: positions.smallBlindSeat,
    bigBlindSeat: positions.bigBlindSeat,
    communityCards: [],
    collectedPot: 0,
    pots: [],
    players,
    deck: action.deck ? deckFromCards(action.deck) : shuffledDeck(rng),
    round: {
      currentBet: config.bigBlind,
      lastRaiseSize: config.bigBlind,
      lastAggressorSeat: null,
      minOpen: config.bigBlind,
    },
    actingSeat: null,
    actionDeadline: null,
  };

  const events: GameEvent[] = [
    {
      type: 'HAND_STARTED',
      handId: action.handId,
      handNumber: action.handNumber,
      buttonSeat: positions.buttonSeat,
      smallBlindSeat: positions.smallBlindSeat,
      bigBlindSeat: positions.bigBlindSeat,
      players: players
        .filter((p) => seats.includes(p.seatNumber))
        .map((p) => ({ seat: p.seatNumber, userId: p.userId, stack: p.stack })),
    },
  ];

  working = postBlind(working, positions.smallBlindSeat, config.smallBlind, 'SMALL', events);
  working = postBlind(working, positions.bigBlindSeat, config.bigBlind, 'BIG', events);

  const dealt = dealHoleCards(working);
  working = dealt.state;
  events.push({ type: 'HOLE_CARDS_DEALT', hands: dealt.hands });

  working = { ...working, actingSeat: firstActionable(working, positions.firstToActPreflop) };

  return progress(working, events, rng);
}

function postBlind(
  state: GameState,
  seat: number,
  amount: number,
  blind: 'SMALL' | 'BIG',
  events: GameEvent[],
): GameState {
  const player = getPlayer(state, seat);
  if (!player) return state;
  const { player: committed, committed: paid } = commitChips(player, amount);
  const withAction: PlayerState = {
    ...committed,
    lastAction: blind === 'SMALL' ? PlayerActionType.PostSmallBlind : PlayerActionType.PostBigBlind,
  };
  events.push({ type: 'BLIND_POSTED', seat, amount: paid, blind });
  if (withAction.status === PlayerStatus.AllIn) {
    events.push({ type: 'PLAYER_WENT_ALL_IN', seat, amount: withAction.currentBet });
  }
  return { ...state, players: replacePlayer(state.players, withAction) };
}

// ---------------------------------------------------------------------------
// PLAYER_ACTION / TIMEOUT
// ---------------------------------------------------------------------------

function applyPlayerAction(
  state: GameState,
  seat: number,
  action: PlayerAction,
  rng: RandomProvider,
): ReduceResult {
  if (state.street === Street.Waiting || state.street === Street.Complete) {
    return reject(state, seat, 'NO_HAND', 'there is no hand in progress');
  }

  const ctx = toBettingContext(state);
  const concrete = action.type === 'ALL_IN' ? expandAllIn(state, seat) : action;
  const verdict = validateAction(ctx, seat, concrete);
  if (!verdict.ok) {
    return reject(state, seat, verdict.code, verdict.reason);
  }

  const player = getPlayer(state, seat) as PlayerState;
  const before = player.currentBet + player.stack;

  const { context, events } = applyConcrete(ctx, seat, concrete);
  let working: GameState = { ...state, players: context.players, round: context.round };

  const after = getPlayer(working, seat) as PlayerState;
  if (after.status === PlayerStatus.AllIn && before !== 0) {
    events.push({ type: 'PLAYER_WENT_ALL_IN', seat, amount: after.currentBet });
  }

  working = { ...working, actingSeat: nextActingSeat(working, seat) };
  return progress(working, events, rng);
}

function applyTimeout(state: GameState, seat: number, rng: RandomProvider): ReduceResult {
  if (state.actingSeat !== seat) {
    return reject(state, seat, 'NOT_YOUR_TURN', 'not this seat to act');
  }
  const owed = amountToCall(getPlayer(state, seat)?.currentBet ?? 0, state.round);
  const resolvedAs = owed === 0 ? 'CHECK' : 'FOLD';
  const result = applyPlayerAction(state, seat, owed === 0 ? checkAction() : foldAction(), rng);
  return {
    state: result.state,
    events: [{ type: 'ACTION_TIMED_OUT', seat, resolvedAs }, ...result.events],
  };
}

/** Expands ALL_IN into the concrete bet/call/raise for the player's whole stack. */
function expandAllIn(state: GameState, seat: number): PlayerAction {
  const player = getPlayer(state, seat);
  if (!player) return callAction();
  const target = player.currentBet + player.stack;
  const owed = amountToCall(player.currentBet, state.round);

  if (state.round.currentBet === 0) return betTo(target);
  if (target <= state.round.currentBet || player.hasActed) return callAction();
  if (owed >= player.stack) return callAction();
  return raiseTo(target);
}

function applyConcrete(
  ctx: BettingContext,
  seat: number,
  action: PlayerAction,
): { context: BettingContext; events: GameEvent[] } {
  const before = ctx.players.find((p) => p.seatNumber === seat) as PlayerState;
  switch (action.type) {
    case 'FOLD':
      return { context: applyFold(ctx), events: [{ type: 'PLAYER_FOLDED', seat }] };
    case 'CHECK':
      return { context: applyCheck(ctx), events: [{ type: 'PLAYER_CHECKED', seat }] };
    case 'CALL': {
      const context = applyCall(ctx);
      const after = context.players.find((p) => p.seatNumber === seat) as PlayerState;
      return {
        context,
        events: [
          {
            type: 'PLAYER_CALLED',
            seat,
            amount: after.currentBet - before.currentBet,
            allIn: after.status === PlayerStatus.AllIn,
          },
        ],
      };
    }
    case 'BET': {
      const context = applyBet(ctx, action.amount);
      const after = context.players.find((p) => p.seatNumber === seat) as PlayerState;
      return {
        context,
        events: [
          {
            type: 'PLAYER_BET',
            seat,
            amount: after.currentBet,
            allIn: after.status === PlayerStatus.AllIn,
          },
        ],
      };
    }
    case 'RAISE': {
      const context = applyRaise(ctx, action.amount);
      const after = context.players.find((p) => p.seatNumber === seat) as PlayerState;
      return {
        context,
        events: [
          {
            type: 'PLAYER_RAISED',
            seat,
            amount: after.currentBet,
            allIn: after.status === PlayerStatus.AllIn,
          },
        ],
      };
    }
    default:
      return { context: ctx, events: [] };
  }
}

// ---------------------------------------------------------------------------
// progression: streets, run-outs, settlement
// ---------------------------------------------------------------------------

function progress(state: GameState, events: GameEvent[], rng: RandomProvider): ReduceResult {
  let working = state;

  for (let guard = 0; guard < 32; guard += 1) {
    if (contestingPlayers(working).length <= 1) {
      return settleByFold(working, events);
    }

    const ctx = toBettingContext(working);
    if (!isBettingRoundComplete(ctx)) {
      const acting = working.actingSeat;
      if (acting === null || getPlayer(working, acting)?.status !== PlayerStatus.Active) {
        working = { ...working, actingSeat: nextActingSeat(working, acting ?? working.buttonSeat) };
      }
      return { state: working, events };
    }

    if (working.street === Street.River) {
      return settleByShowdown(working, events, rng);
    }

    if (shouldRunOut(working.players)) {
      working = collectBets(working, events).state;
      working = runOutBoard(working, events);
      return settleByShowdown(working, events, rng);
    }

    working = collectBets(working, events).state;
    working = openNextStreet(working, events);
  }

  return { state: working, events };
}

function collectBets(state: GameState, events: GameEvent[]): { state: GameState } {
  const bets = state.players
    .map((p) => ({ seat: p.seatNumber, currentBet: p.currentBet }))
    .filter((b) => b.currentBet > 0);

  let players = state.players;
  const refund = contestingPlayers(state).length >= 2 ? returnUncalledBet(bets) : null;
  if (refund && refund.amount > 0) {
    players = players.map((p) =>
      p.seatNumber === refund.seat
        ? {
            ...p,
            stack: p.stack + refund.amount,
            currentBet: p.currentBet - refund.amount,
            totalInvested: p.totalInvested - refund.amount,
          }
        : p,
    );
    events.push({ type: 'BET_RETURNED', seat: refund.seat, amount: refund.amount });
  }

  const collected = players.reduce((sum, p) => sum + p.currentBet, 0);
  players = players.map((p) => ({ ...p, currentBet: 0 }));
  const collectedPot = state.collectedPot + collected;
  events.push({ type: 'BETTING_ROUND_ENDED', street: state.street, collectedPot });
  return { state: { ...state, players, collectedPot } };
}

function openNextStreet(state: GameState, events: GameEvent[]): GameState {
  const street = nextStreet(state.street);
  let working = dealStreet({ ...state, street }, events);
  working = {
    ...working,
    players: working.players.map(resetForStreet),
    round: createBettingRound(state.config.bigBlind, 0),
  };
  const contesting = contestingPlayers(working).map((p) => p.seatNumber);
  const firstSeat = firstToActPostflop(working.buttonSeat, contesting);
  return {
    ...working,
    actingSeat: firstSeat === null ? null : firstActionable(working, firstSeat),
  };
}

function runOutBoard(state: GameState, events: GameEvent[]): GameState {
  let working = state;
  while (working.street !== Street.River && working.street !== Street.Showdown) {
    working = { ...working, street: nextStreet(working.street) };
    working = dealStreet(working, events);
  }
  return working;
}

function dealStreet(state: GameState, events: GameEvent[]): GameState {
  switch (state.street) {
    case Street.Flop: {
      const { state: next, cards, burned } = dealFlop(state);
      events.push({ type: 'FLOP_DEALT', cards, burned });
      return next;
    }
    case Street.Turn: {
      const { state: next, card, burned } = dealTurn(state);
      events.push({ type: 'TURN_DEALT', card, burned });
      return next;
    }
    case Street.River: {
      const { state: next, card, burned } = dealRiver(state);
      events.push({ type: 'RIVER_DEALT', card, burned });
      return next;
    }
    default:
      return state;
  }
}

function settleByFold(state: GameState, events: GameEvent[]): ReduceResult {
  const contenders = contestingPlayers(state);
  const winner = contenders[0];
  const onTable = state.players.reduce((sum, p) => sum + p.currentBet, 0);
  const amount = state.collectedPot + onTable;

  let players = state.players.map((p) => ({ ...p, currentBet: 0 }));
  if (winner) {
    players = players.map((p) =>
      p.seatNumber === winner.seatNumber ? { ...p, stack: p.stack + amount } : p,
    );
  }

  const pots = winner ? [{ amount, eligibleSeats: [winner.seatNumber] }] : [];
  if (winner && amount > 0) {
    events.push({
      type: 'POT_AWARDED',
      potIndex: 0,
      potType: 'MAIN',
      amount,
      winners: [{ seat: winner.seatNumber, amount }],
    });
  }

  const finished: GameState = {
    ...state,
    players,
    pots,
    collectedPot: amount,
    street: Street.Complete,
    actingSeat: null,
    round: { ...state.round, currentBet: 0 },
  };
  events.push(handCompleted(state, finished));
  return { state: finished, events };
}

function settleByShowdown(
  state: GameState,
  events: GameEvent[],
  _rng: RandomProvider,
): ReduceResult {
  const collected = collectBets(state, events).state;

  const contributions: Contribution[] = collected.players
    .filter((p) => p.totalInvested > 0)
    .map((p) => ({
      seat: p.seatNumber,
      contributed: p.totalInvested,
      folded: p.status === PlayerStatus.Folded,
    }));
  const { pots, deadRefunds } = buildPots(contributions);

  // Return chips no contesting player matched (all high bettors folded).
  let refundedPlayers = collected.players;
  let collectedPot = collected.collectedPot;
  for (const refund of deadRefunds) {
    if (refund.amount <= 0) continue;
    refundedPlayers = refundedPlayers.map((p) =>
      p.seatNumber === refund.seat ? { ...p, stack: p.stack + refund.amount } : p,
    );
    collectedPot -= refund.amount;
    events.push({ type: 'BET_RETURNED', seat: refund.seat, amount: refund.amount });
  }
  const collectedAfterRefunds: GameState = {
    ...collected,
    players: refundedPlayers,
    collectedPot,
  };

  const ranks = evaluateShowdown(collectedAfterRefunds);
  events.push({ type: 'SHOWDOWN_STARTED' });
  for (const seat of showdownOrder(collectedAfterRefunds)) {
    const player = getPlayer(collectedAfterRefunds, seat);
    const rank = ranks.get(seat);
    if (player && rank) {
      events.push({
        type: 'HAND_REVEALED',
        seat,
        cards: player.holeCards,
        hand: summarizeHand(rank),
      });
    }
  }

  const oddChipOrder = clockwiseFrom(
    firstToActPostflop(
      collectedAfterRefunds.buttonSeat,
      [...ranks.keys()].sort((a, b) => a - b),
    ) ?? collectedAfterRefunds.buttonSeat,
    [...ranks.keys()],
  );
  const awards = awardPots(pots, ranks, oddChipOrder);

  const payoutBySeat = new Map<number, number>();
  awards.forEach((award, index) => {
    for (const w of award.winners) {
      payoutBySeat.set(w.seat, (payoutBySeat.get(w.seat) ?? 0) + w.amount);
    }
    events.push({
      type: 'POT_AWARDED',
      potIndex: index,
      potType: index === 0 ? 'MAIN' : 'SIDE',
      amount: award.amount,
      winners: award.winners,
    });
  });

  const players = collectedAfterRefunds.players.map((p) => ({
    ...p,
    stack: p.stack + (payoutBySeat.get(p.seatNumber) ?? 0),
  }));

  const finished: GameState = {
    ...collectedAfterRefunds,
    players,
    pots,
    street: Street.Complete,
    actingSeat: null,
  };
  events.push(handCompleted(state, finished));
  return { state: finished, events };
}

function handCompleted(startState: GameState, endState: GameState): GameEvent {
  return {
    type: 'HAND_COMPLETED',
    results: endState.players.map((p) => {
      const startPlayer = getPlayer(startState, p.seatNumber);
      const startStack = (startPlayer?.stack ?? p.stack) + (startPlayer?.totalInvested ?? 0);
      return { seat: p.seatNumber, userId: p.userId, net: p.stack - startStack, stack: p.stack };
    }),
  };
}

// ---------------------------------------------------------------------------
// SIT_OUT / RETURN
// ---------------------------------------------------------------------------

function setStatus(state: GameState, seat: number, status: PlayerStatus): ReduceResult {
  const player = getPlayer(state, seat);
  if (!player) return reject(state, seat, 'NO_SUCH_SEAT', `no player at seat ${seat}`);
  // Mid-hand this only takes effect next hand; if idle, apply immediately.
  const applyNow = state.street === Street.Waiting || state.street === Street.Complete;
  const next: PlayerState = applyNow
    ? { ...player, status }
    : player.status === PlayerStatus.Active
      ? player // still owes action this hand
      : { ...player, status };
  return { state: { ...state, players: replacePlayer(state.players, next) }, events: [] };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function toBettingContext(state: GameState): BettingContext {
  return { players: state.players, round: state.round, actingSeat: state.actingSeat ?? -1 };
}

function firstActionable(state: GameState, preferredSeat: number): number | null {
  const preferred = getPlayer(state, preferredSeat);
  if (preferred && canAct(preferred)) return preferredSeat;
  return nextActingSeat(state, preferredSeat);
}

function replacePlayer(players: readonly PlayerState[], updated: PlayerState): PlayerState[] {
  return players.map((p) => (p.seatNumber === updated.seatNumber ? updated : p));
}

function clockwiseFrom(startSeat: number, seats: readonly number[]): number[] {
  const sorted = [...seats].sort((a, b) => a - b);
  const index = sorted.findIndex((s) => s >= startSeat);
  const pivot = index === -1 ? 0 : index;
  return [...sorted.slice(pivot), ...sorted.slice(0, pivot)];
}

function reject(state: GameState, seat: number, code: string, reason: string): ReduceResult {
  return { state, events: [{ type: 'ACTION_REJECTED', seat, code, reason }] };
}

/** Re-exported for callers that want to pre-check before dispatching. */
export { validateAction, ValidationCode };
