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
  potLimitMaxTo,
} from '../betting/betting';
import { rulesFor } from '../variant/variant';
import { type GameEvent } from '../events/events';
import { compareHandRanks, type HandRank } from '../hand-evaluator/hand-rank';
import { compareLowRanks, type LowRank } from '../hand-evaluator/low';
import {
  contestingPlayers,
  type GameState,
  getPlayer,
  nextActingSeat,
  Street,
} from '../game-state/game-state';
import {
  awardPots,
  awardPotsHiLo,
  buildPots,
  type Contribution,
  returnUncalledBet,
} from '../pot-manager/pot-manager';
import {
  canAct,
  commitChips,
  isInHand,
  type PlayerState,
  PlayerActionType,
  PlayerStatus,
  postAnte,
  resetForHand,
  resetForStreet,
} from '../player/player';
import { type RandomProvider } from '../rng/random-provider';
import {
  evaluateLowShowdown,
  evaluateShowdown,
  showdownOrder,
  summarizeHand,
  summarizeLow,
} from '../showdown/showdown';
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
  type PreviousPositions,
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
      /** The previous hand's positions, for correct forward-moving-blind
       * rotation. `null` for a table's very first hand. */
      readonly previousPositions: PreviousPositions | null;
      /**
       * Optional explicit 52-card deal order. When omitted, `rng` shuffles a
       * fresh deck. Supplying it makes a hand fully reproducible - the
       * application persists `{ deck, actions[] }` and `replayHand` re-runs it.
       */
      readonly deck?: readonly Card[];
      /**
       * When present, this hand is a **bomb pot**: every player being dealt in
       * posts `amount` as dead money before the deal (their whole stack, and
       * all-in, if they cannot cover it), there is NO preflop betting round, and
       * play goes straight to the flop. The blinds and antes are not posted -
       * the bomb contribution replaces them. The application (never the client)
       * decides when a hand is a bomb pot and passes this. Hold'em only.
       */
      readonly bombPot?: { readonly amount: number };
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
  if (action.bombPot) {
    if (rulesFor(state.config.variant).holeCards !== 2) {
      return reject(state, -1, 'BOMB_POT_HOLDEM_ONLY', 'bomb pots are only supported for Hold’em');
    }
    if (!Number.isInteger(action.bombPot.amount) || action.bombPot.amount <= 0) {
      return reject(state, -1, 'BOMB_POT_AMOUNT', 'bomb-pot amount must be a positive integer');
    }
  }

  const reset = state.players.map(resetForHand);
  const seats = seatsForNextHand(reset);
  if (seats.length < 2) {
    // Not enough players to deal - go idle, and clear every trace of the last
    // hand so nothing (stale pot totals, board, betting round) leaks forward.
    return {
      state: {
        ...state,
        players: reset,
        street: Street.Waiting,
        communityCards: [],
        collectedPot: 0,
        pots: [],
        actingSeat: null,
        actionDeadline: null,
        round: {
          currentBet: 0,
          lastRaiseSize: state.config.bigBlind,
          lastAggressorSeat: null,
          minOpen: state.config.bigBlind,
        },
      },
      events: [],
    };
  }

  const positions = assignPositions(seats, action.previousPositions, state.config.maxSeats);
  const { config } = state;

  const players: PlayerState[] = reset.map((p) => ({
    ...p,
    isDealer: p.seatNumber === positions.buttonSeat,
    isSmallBlind: positions.smallBlindSeat !== null && p.seatNumber === positions.smallBlindSeat,
    isBigBlind: p.seatNumber === positions.bigBlindSeat,
  }));

  const bomb = action.bombPot;

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
      currentBet: bomb ? 0 : config.bigBlind,
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

  if (bomb) {
    // Bomb pot: everyone posts the bomb amount as dead money (their whole stack
    // if short), the blinds and antes are not posted, and there is no preflop
    // betting - play goes straight to the flop. The button/blind seats are
    // still assigned above so rotation continuity is unaffected.
    events.push({
      type: 'BOMB_POT_STARTED',
      amount: bomb.amount,
      eligibleSeats: seats,
    });
    working = postDeadMoney(working, bomb.amount, 'BOMB', events);
  } else {
    // Antes first (dead money), then the blinds - matching a live-poker deal.
    if (config.ante > 0) {
      working = postDeadMoney(working, config.ante, 'ANTE', events);
    }
    if (positions.smallBlindSeat !== null) {
      working = postBlind(working, positions.smallBlindSeat, config.smallBlind, 'SMALL', events);
    }
    working = postBlind(working, positions.bigBlindSeat, config.bigBlind, 'BIG', events);
  }

  const dealt = dealHoleCards(working);
  working = dealt.state;
  events.push({ type: 'HOLE_CARDS_DEALT', hands: dealt.hands });

  if (bomb) {
    // Straight to the flop - the same street machinery `progress` uses, so the
    // flop actor, run-outs, and settlement are all the existing NLHE logic.
    working = openNextStreet(working, events);
  } else {
    working = { ...working, actingSeat: firstActionable(working, positions.firstToActPreflop) };
  }

  return progress(working, events, rng);
}

/**
 * Every player being dealt in posts a forced dead-money contribution before the
 * deal - an ante (`kind: 'ANTE'`), or the whole table's bomb-pot contribution
 * (`kind: 'BOMB'`). It goes straight into `collectedPot` and each player's
 * `totalInvested` (so `buildPots` puts it in the right main / side pot) but
 * never into `currentBet`, so it does not reduce what anyone owes to call. A
 * player the contribution empties is all-in for the hand. The two kinds are
 * accounted identically - only the events and the `lastAction` tag differ.
 */
function postDeadMoney(
  state: GameState,
  amount: number,
  kind: 'ANTE' | 'BOMB',
  events: GameEvent[],
): GameState {
  let players = state.players;
  let collectedPot = state.collectedPot;
  const seats = [...state.players].map((p) => p.seatNumber).sort((a, b) => a - b);
  for (const seat of seats) {
    const player = players.find((p) => p.seatNumber === seat);
    if (!player || player.status !== PlayerStatus.Active || player.stack <= 0) continue;
    const { player: posted, committed } = postAnte(player, amount);
    if (committed <= 0) continue;
    const after = kind === 'BOMB' ? { ...posted, lastAction: PlayerActionType.PostBomb } : posted;
    players = replacePlayer(players, after);
    collectedPot += committed;
    events.push({
      type: kind === 'BOMB' ? 'BOMB_POT_POSTED' : 'ANTE_POSTED',
      seat,
      amount: committed,
    });
    if (after.status === PlayerStatus.AllIn) {
      events.push({ type: 'PLAYER_WENT_ALL_IN', seat, amount: after.totalInvested });
    }
  }
  return { ...state, players, collectedPot };
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
  // The ante can already have moved this player all-in (stack 0). They post no
  // blind and were flagged all-in when the ante was taken - leave them be.
  if (paid === 0 && player.status === PlayerStatus.AllIn) return state;
  const withAction: PlayerState = {
    ...committed,
    lastAction: blind === 'SMALL' ? PlayerActionType.PostSmallBlind : PlayerActionType.PostBigBlind,
  };
  if (paid > 0) events.push({ type: 'BLIND_POSTED', seat, amount: paid, blind });
  if (withAction.status === PlayerStatus.AllIn && player.status !== PlayerStatus.AllIn) {
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

/**
 * Expands ALL_IN into the concrete bet/call/raise for the player's whole stack.
 * Under pot-limit a stack deeper than the pot can't be wagered in full, so
 * "all in" becomes a pot-sized bet or raise instead.
 */
function expandAllIn(state: GameState, seat: number): PlayerAction {
  const player = getPlayer(state, seat);
  if (!player) return callAction();
  const owed = amountToCall(player.currentBet, state.round);
  let target = player.currentBet + player.stack;

  if (rulesFor(state.config.variant).bettingLimit === 'POT_LIMIT') {
    target = Math.min(target, potLimitMaxTo(toBettingContext(state), seat));
  }

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

  let players: PlayerState[];
  if (winner) {
    players = state.players.map((p) => ({
      ...p,
      currentBet: 0,
      stack: p.seatNumber === winner.seatNumber ? p.stack + amount : p.stack,
    }));
  } else {
    // No eligible winner (only reachable from a corrupted state) - never eat
    // chips: hand every player back exactly what they still had on the table
    // plus an equal share of any already-collected pot, remainder left in the
    // first seat.
    const share = contenders.length === 0 ? state.players.length : contenders.length;
    const base = Math.floor(state.collectedPot / share);
    let remainder = state.collectedPot - base * share;
    players = state.players.map((p, i) => {
      const refund = p.currentBet + base + (remainder > 0 && i === 0 ? remainder : 0);
      if (remainder > 0 && i === 0) remainder = 0;
      return { ...p, currentBet: 0, stack: p.stack + refund };
    });
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
    collectedPot: winner ? amount : 0,
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

  const hiLo = rulesFor(collectedAfterRefunds.config.variant).hiLo;
  const ranks = evaluateShowdown(collectedAfterRefunds);
  const lows = hiLo ? evaluateLowShowdown(collectedAfterRefunds) : new Map<number, LowRank>();
  events.push({ type: 'SHOWDOWN_STARTED' });

  // A player mucks rather than expose their cards only when they called a river
  // bet with chips behind (status ACTIVE) and cannot win or chop any pot they
  // are eligible for - for the high, or (hi/lo) for a qualifying low. All-in
  // hands are always tabled, and if at most one player could still wager then
  // the whole hand was all-in - table everything.
  const stillWagering = contestingPlayers(collectedAfterRefunds).filter(
    (p) => p.status !== PlayerStatus.AllIn,
  ).length;
  const tableEveryHand = stillWagering <= 1;

  const revealed = new Map<number, HandRank>();
  const revealedLo = new Map<number, LowRank>();
  for (const seat of showdownOrder(collectedAfterRefunds)) {
    const player = getPlayer(collectedAfterRefunds, seat);
    const rank = ranks.get(seat);
    if (!player || !rank) continue;
    const lowRank = lows.get(seat);

    const eligiblePots = pots.filter((pot) => pot.eligibleSeats.includes(seat));
    const canWinHi = eligiblePots.some((pot) =>
      beatsOrTiesShown(rank, revealed, pot, compareHandRanks),
    );
    const canWinLo =
      lowRank !== undefined &&
      eligiblePots.some((pot) => beatsOrTiesShown(lowRank, revealedLo, pot, compareLowRanks));

    const mayMuck = player.status === PlayerStatus.Active && !tableEveryHand;
    if (!mayMuck || canWinHi || canWinLo || revealed.size === 0) {
      revealed.set(seat, rank);
      if (lowRank) revealedLo.set(seat, lowRank);
      events.push({
        type: 'HAND_REVEALED',
        seat,
        cards: player.holeCards,
        hand: summarizeHand(rank),
        ...(lowRank ? { low: summarizeLow(lowRank) } : {}),
      });
    } else {
      events.push({ type: 'HAND_MUCKED', seat });
    }
  }

  const oddChipOrder = clockwiseFrom(
    firstToActPostflop(
      collectedAfterRefunds.buttonSeat,
      [...revealed.keys()].sort((a, b) => a - b),
    ) ?? collectedAfterRefunds.buttonSeat,
    [...revealed.keys()],
  );

  const payoutBySeat = new Map<number, number>();
  const credit = (seat: number, amount: number): void => {
    payoutBySeat.set(seat, (payoutBySeat.get(seat) ?? 0) + amount);
  };

  if (hiLo) {
    const awards = awardPotsHiLo(pots, revealed, revealedLo, oddChipOrder);
    awards.forEach((award, index) => {
      const potType = index === 0 ? 'MAIN' : 'SIDE';
      for (const w of award.hi) credit(w.seat, w.amount);
      for (const w of award.lo) credit(w.seat, w.amount);
      const split = award.lo.length > 0;
      events.push({
        type: 'POT_AWARDED',
        potIndex: index,
        potType,
        amount: award.hi.reduce((t, w) => t + w.amount, 0),
        winners: award.hi,
        ...(split ? { portion: 'HIGH' as const } : {}),
      });
      if (split) {
        events.push({
          type: 'POT_AWARDED',
          potIndex: index,
          potType,
          amount: award.lo.reduce((t, w) => t + w.amount, 0),
          winners: award.lo,
          portion: 'LOW',
        });
      }
    });
  } else {
    const awards = awardPots(pots, revealed, oddChipOrder);
    awards.forEach((award, index) => {
      for (const w of award.winners) credit(w.seat, w.amount);
      events.push({
        type: 'POT_AWARDED',
        potIndex: index,
        potType: index === 0 ? 'MAIN' : 'SIDE',
        amount: award.amount,
        winners: award.winners,
      });
    });
  }

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

  const idle = state.street === Street.Waiting || state.street === Street.Complete;
  // A player who is dealt into the live hand (ACTIVE / ALL_IN) or has folded
  // it still has chips tied up in the pot - their seat status must not be
  // rewritten until the hand is over. The application layer tracks the intent
  // (roster `sittingOut`) and it takes effect at the next START_HAND.
  const boundToHand = !idle && (isInHand(player) || player.status === PlayerStatus.Folded);
  if (boundToHand) {
    return reject(state, seat, 'IN_HAND', 'cannot change seat status during a hand');
  }

  return {
    state: { ...state, players: replacePlayer(state.players, { ...player, status }) },
    events: [],
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function toBettingContext(state: GameState): BettingContext {
  return {
    players: state.players,
    round: state.round,
    actingSeat: state.actingSeat ?? -1,
    potBeforeRound: state.collectedPot,
    bettingLimit: rulesFor(state.config.variant).bettingLimit,
  };
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

/** True if `mine` beats or ties the best already-shown hand among the seats
 * eligible for `pot` (or nothing eligible has been shown yet). `cmp` is
 * `compareHandRanks` for the high or `compareLowRanks` for the low. */
function beatsOrTiesShown<T>(
  mine: T,
  shown: ReadonlyMap<number, T>,
  pot: { eligibleSeats: readonly number[] },
  cmp: (a: T, b: T) => number,
): boolean {
  let best: T | undefined;
  for (const [seat, rank] of shown) {
    if (!pot.eligibleSeats.includes(seat)) continue;
    if (best === undefined || cmp(rank, best) > 0) best = rank;
  }
  return best === undefined || cmp(mine, best) >= 0;
}

function reject(state: GameState, seat: number, code: string, reason: string): ReduceResult {
  return { state, events: [{ type: 'ACTION_REJECTED', seat, code, reason }] };
}

/** Re-exported for callers that want to pre-check before dispatching. */
export { validateAction, ValidationCode };
