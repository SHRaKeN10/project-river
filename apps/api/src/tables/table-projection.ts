import {
  type BettingContext,
  cardToString,
  type GameState,
  legalActions,
  type PlayerState,
  Street,
  totalPot,
} from '@river/poker-engine';
import type { ActionOptionView, PublicSeatView, TableStateView } from '@river/shared-types';

export interface RosterEntry {
  userId: string;
  username: string;
  avatarUrl: string | null;
  connected: boolean;
  stack: number;
  sittingOut: boolean;
}

export interface TableMeta {
  id: string;
  name: string;
  gameType: string;
  smallBlind: number;
  bigBlind: number;
  maxSeats: number;
  minBuyIn: number;
  maxBuyIn: number;
}

export interface ProjectParams {
  table: TableMeta;
  state: GameState;
  roster: ReadonlyMap<number, RosterEntry>;
  /** Seats whose hole cards have become public (showdown). */
  revealedSeats: ReadonlySet<number>;
  viewerUserId: string | null;
}

/**
 * Builds the view one specific viewer is allowed to see. The deck, its seed,
 * and other players' hole cards never leave the server through here.
 */
export function projectTableState(params: ProjectParams): TableStateView {
  const { table, state, roster, revealedSeats, viewerUserId } = params;
  const handInProgress = state.street !== Street.Waiting;

  const enginePlayerBySeat = new Map(state.players.map((p) => [p.seatNumber, p]));
  const viewerSeat = findViewerSeat(roster, viewerUserId);

  const seats: PublicSeatView[] = [];
  for (let seatNumber = 0; seatNumber < table.maxSeats; seatNumber += 1) {
    const entry = roster.get(seatNumber);
    if (!entry) continue;
    const enginePlayer = enginePlayerBySeat.get(seatNumber);
    seats.push(
      buildSeatView({
        seatNumber,
        entry,
        enginePlayer,
        handInProgress,
        canSeeCards: seatNumber === viewerSeat || revealedSeats.has(seatNumber),
      }),
    );
  }

  const showLegal =
    handInProgress &&
    state.actingSeat !== null &&
    roster.get(state.actingSeat)?.userId === viewerUserId;

  return {
    tableId: table.id,
    name: table.name,
    gameType: table.gameType,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    maxSeats: table.maxSeats,
    minBuyIn: table.minBuyIn,
    maxBuyIn: table.maxBuyIn,

    handId: handInProgress ? state.handId : null,
    handNumber: state.handNumber,
    street: state.street,
    buttonSeat: handInProgress ? state.buttonSeat : null,
    communityCards: state.communityCards.map(cardToString),
    pot: handInProgress ? totalPot(state) : 0,
    pots: state.pots.map((p) => ({ amount: p.amount, eligibleSeats: [...p.eligibleSeats] })),
    currentBet: state.round.currentBet,

    seats,
    actingSeat: handInProgress ? state.actingSeat : null,
    actionDeadline: state.actionDeadline,

    youAreSeat: viewerSeat,
    legalActions: showLegal ? projectLegalActions(state) : null,
  };
}

function buildSeatView(args: {
  seatNumber: number;
  entry: RosterEntry;
  enginePlayer: PlayerState | undefined;
  handInProgress: boolean;
  canSeeCards: boolean;
}): PublicSeatView {
  const { seatNumber, entry, enginePlayer, handInProgress, canSeeCards } = args;
  const inHand = handInProgress && enginePlayer !== undefined;

  return {
    seatNumber,
    userId: entry.userId,
    username: entry.username,
    avatarUrl: entry.avatarUrl,
    stack: inHand ? (enginePlayer as PlayerState).stack : entry.stack,
    currentBet: inHand ? (enginePlayer as PlayerState).currentBet : 0,
    totalInvested: inHand ? (enginePlayer as PlayerState).totalInvested : 0,
    status: inHand
      ? (enginePlayer as PlayerState).status
      : entry.sittingOut
        ? 'SITTING_OUT'
        : 'WAITING',
    lastAction: inHand ? (enginePlayer as PlayerState).lastAction : null,
    isDealer: inHand ? (enginePlayer as PlayerState).isDealer : false,
    isSmallBlind: inHand ? (enginePlayer as PlayerState).isSmallBlind : false,
    isBigBlind: inHand ? (enginePlayer as PlayerState).isBigBlind : false,
    connected: entry.connected,
    holeCards:
      inHand && canSeeCards && (enginePlayer as PlayerState).holeCards.length > 0
        ? (enginePlayer as PlayerState).holeCards.map(cardToString)
        : null,
  };
}

function projectLegalActions(state: GameState): ActionOptionView[] {
  if (state.actingSeat === null) return [];
  const ctx: BettingContext = {
    players: state.players,
    round: state.round,
    actingSeat: state.actingSeat,
  };
  return legalActions(ctx, state.actingSeat).map((option) => ({
    kind: option.kind,
    callAmount: option.callAmount,
    min: option.min,
    max: option.max,
  }));
}

function findViewerSeat(
  roster: ReadonlyMap<number, RosterEntry>,
  viewerUserId: string | null,
): number | null {
  if (!viewerUserId) return null;
  for (const [seat, entry] of roster) {
    if (entry.userId === viewerUserId) return seat;
  }
  return null;
}
