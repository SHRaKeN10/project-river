import {
  type BettingContext,
  cardToString,
  type GameState,
  legalActions,
  type PlayerState,
  rulesFor,
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
  /** The player has armed the UTG straddle (ADR-0027). */
  straddleOn: boolean;
  /** The player has armed "run it twice" (ADR-0028). */
  runItTwiceOn: boolean;
  /** Epoch millis the seat's time charge was last applied (or joined-at, before the first one). */
  lastTimeChargeAt: number;
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
  /** Flat per-seat time charge (membership-club billing, not a pot rake).
   * Either being 0 disables it. */
  timeChargeAmount: number;
  timeChargeIntervalMs: number;
  /** Bomb pots (NLHE cash only, ADR-0026). `bombPotAmount` 0 means "use the big
   * blind". `bombPotEnabled` false leaves the table playing exactly as before. */
  bombPotEnabled: boolean;
  bombPotIntervalHands: number;
  bombPotAmount: number;
  /** Voluntary UTG straddle (NLHE cash only, ADR-0027). `straddleEnabled` false
   * leaves the table playing exactly as before. */
  straddleEnabled: boolean;
  straddleMultiplier: number;
  /** Run It Twice (NLHE cash only, ADR-0028). */
  runItTwiceEnabled: boolean;
  /** Anti-ratholing cooldown in minutes (ADR-0029); 0 = off. Enforced in
   * `TablesService.sitDown`, surfaced here for the buy-in UI. */
  antiRatholeMinutes: number;
}

export interface ProjectParams {
  table: TableMeta;
  state: GameState;
  roster: ReadonlyMap<number, RosterEntry>;
  /** Seats whose hole cards have become public (showdown). */
  revealedSeats: ReadonlySet<number>;
  viewerUserId: string | null;
  /** Public bomb-pot state (the runner owns "is this a bomb pot"). `null` on a
   * table that doesn't run bomb pots. */
  bombPot?: TableStateView['bombPot'];
  /** Public straddle state (the runner owns "is this hand straddled"). `null` on
   * a table that doesn't allow straddling. */
  straddle?: TableStateView['straddle'];
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
    if (!entry) {
      // Empty seat slot - the client renders these as "sit here" targets.
      seats.push(emptySeatView(seatNumber));
      continue;
    }
    const enginePlayer = enginePlayerBySeat.get(seatNumber);
    seats.push(
      buildSeatView({
        seatNumber,
        entry,
        enginePlayer,
        handInProgress,
        canSeeCards: seatNumber === viewerSeat || revealedSeats.has(seatNumber),
        isStraddle:
          handInProgress && params.straddle?.active === true && params.straddle.seat === seatNumber,
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
    timeChargeAmount: table.timeChargeAmount,
    timeChargeIntervalMs: table.timeChargeIntervalMs,
    antiRatholeMinutes: table.antiRatholeMinutes,

    handId: handInProgress ? state.handId : null,
    handNumber: state.handNumber,
    street: state.street,
    buttonSeat: handInProgress ? state.buttonSeat : null,
    communityCards: state.communityCards.map(cardToString),
    secondBoard: state.secondBoard.map(cardToString),
    pot: handInProgress ? totalPot(state) : 0,
    pots: state.pots.map((p) => ({ amount: p.amount, eligibleSeats: [...p.eligibleSeats] })),
    currentBet: state.round.currentBet,

    seats,
    actingSeat: handInProgress ? state.actingSeat : null,
    actionDeadline: state.actionDeadline,

    youAreSeat: viewerSeat,
    legalActions: showLegal ? projectLegalActions(state) : null,
    bombPot: params.bombPot ?? null,
    straddle: params.straddle ?? null,
    youStraddleNext: viewerSeat !== null && roster.get(viewerSeat)?.straddleOn === true,
    runItTwice: table.runItTwiceEnabled
      ? { enabled: true, armed: handInProgress && state.runItTwice }
      : null,
    youRunItTwice: viewerSeat !== null && roster.get(viewerSeat)?.runItTwiceOn === true,
  };
}

function emptySeatView(seatNumber: number): PublicSeatView {
  return {
    seatNumber,
    userId: null,
    username: null,
    avatarUrl: null,
    stack: 0,
    currentBet: 0,
    totalInvested: 0,
    status: 'EMPTY',
    lastAction: null,
    isDealer: false,
    isSmallBlind: false,
    isBigBlind: false,
    connected: false,
    holeCards: null,
    isStraddle: false,
  };
}

function buildSeatView(args: {
  seatNumber: number;
  entry: RosterEntry;
  enginePlayer: PlayerState | undefined;
  handInProgress: boolean;
  canSeeCards: boolean;
  isStraddle: boolean;
}): PublicSeatView {
  const { seatNumber, entry, enginePlayer, handInProgress, canSeeCards, isStraddle } = args;
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
    isStraddle,
  };
}

function projectLegalActions(state: GameState): ActionOptionView[] {
  if (state.actingSeat === null) return [];
  const ctx: BettingContext = {
    players: state.players,
    round: state.round,
    actingSeat: state.actingSeat,
    // So the client's sizing bounds match the server's - the pot-limit cap for
    // Omaha, the whole stack for Hold'em.
    potBeforeRound: state.collectedPot,
    bettingLimit: rulesFor(state.config.variant).bettingLimit,
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
