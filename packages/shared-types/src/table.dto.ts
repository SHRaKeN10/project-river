import { z } from 'zod';

/**
 * WebSocket table contracts. A card is its compact string form ("As", "Td").
 * The server never sends the deck, its seed, or another player's hole cards
 * (until they are revealed at showdown).
 */

export type WireCard = string;

export const playerActionSchema = z.object({
  type: z.enum(['FOLD', 'CHECK', 'CALL', 'BET', 'RAISE', 'ALL_IN']),
  amount: z.number().int().nonnegative().optional(),
});
export type WirePlayerAction = z.infer<typeof playerActionSchema>;

export const joinTableSchema = z.object({
  tableId: z.string().uuid(),
  seatNumber: z.number().int().min(0).max(8),
  buyIn: z.number().int().positive(),
});
export type JoinTablePayload = z.infer<typeof joinTableSchema>;

export const leaveTableSchema = z.object({ tableId: z.string().uuid() });
export type LeaveTablePayload = z.infer<typeof leaveTableSchema>;

export const straddleToggleSchema = z.object({
  tableId: z.string().uuid(),
  on: z.boolean(),
});
export type StraddleTogglePayload = z.infer<typeof straddleToggleSchema>;

export const runItTwiceToggleSchema = z.object({
  tableId: z.string().uuid(),
  on: z.boolean(),
});
export type RunItTwiceTogglePayload = z.infer<typeof runItTwiceToggleSchema>;

export const tableActionSchema = z.object({
  tableId: z.string().uuid(),
  handId: z.string().min(1),
  /** Client-supplied monotonic id for de-duping double taps / reconnect resends. */
  clientSeq: z.number().int().nonnegative(),
  action: playerActionSchema,
});
export type TableActionPayload = z.infer<typeof tableActionSchema>;

export const tableChatSchema = z.object({
  tableId: z.string().uuid(),
  text: z.string().min(1).max(280),
});
export type TableChatPayload = z.infer<typeof tableChatSchema>;

export const tableRoomSchema = z.object({ tableId: z.string().uuid() });

export interface ActionOptionView {
  kind: 'FOLD' | 'CHECK' | 'CALL' | 'BET' | 'RAISE' | 'ALL_IN';
  callAmount?: number;
  min?: number;
  max?: number;
}

export interface PublicSeatView {
  seatNumber: number;
  userId: string | null;
  username: string | null;
  avatarUrl: string | null;
  stack: number;
  currentBet: number;
  totalInvested: number;
  status: string;
  lastAction: string | null;
  isDealer: boolean;
  isSmallBlind: boolean;
  isBigBlind: boolean;
  connected: boolean;
  /** Present only for the viewer's own seat, or for any seat once revealed at showdown. */
  holeCards: WireCard[] | null;
  /** This seat posted the UTG straddle this hand (ADR-0027). */
  isStraddle: boolean;
}

export interface PotView {
  amount: number;
  eligibleSeats: number[];
}

export interface TableStateView {
  tableId: string;
  /** Set when this table belongs to a tournament - the client filters on this
   * instead of `tableId` (which changes on a balance move). */
  tournamentId?: string;
  name: string;
  gameType: string;
  smallBlind: number;
  bigBlind: number;
  maxSeats: number;
  minBuyIn: number;
  maxBuyIn: number;
  /** Flat per-seat time charge, billed against the wallet not the stack
   * (membership-club billing, not a pot rake). 0 means the table doesn't
   * charge one. Shown as a static rate - there's no per-seat "next charge"
   * countdown on the wire, deliberately. */
  timeChargeAmount: number;
  timeChargeIntervalMs: number;

  handId: string | null;
  handNumber: number;
  street: string;
  buttonSeat: number | null;
  communityCards: WireCard[];
  /** The second board when the hand ran twice (ADR-0028); empty otherwise.
   * `communityCards` is always the first board. */
  secondBoard: WireCard[];
  pot: number;
  pots: PotView[];
  currentBet: number;

  seats: PublicSeatView[];
  actingSeat: number | null;
  /** Epoch millis by which the acting player must act. */
  actionDeadline: number | null;

  /** The viewer's own seat number, or null if spectating. */
  youAreSeat: number | null;
  /** Legal actions with sizing - present only when it is the viewer's turn. */
  legalActions: ActionOptionView[] | null;

  /** Bomb-pot state for NLHE cash tables that have the feature enabled; `null`
   * when the table doesn't run bomb pots. `active` is true only during a
   * bomb-pot hand (every player posted, no preflop betting, straight to the
   * flop); `amount` is the per-player contribution; `nextInHands` counts down to
   * the next bomb pot (0 = this hand). */
  bombPot: { active: boolean; amount: number; nextInHands: number } | null;

  /** UTG straddle state for NLHE cash tables that allow it (ADR-0027); `null`
   * when the table doesn't allow straddling. `active` is true on a hand that was
   * straddled; `seat`/`amount` say who posted it and how much; `multiplier` is
   * the table's straddle size in big blinds. */
  straddle: {
    active: boolean;
    seat: number | null;
    amount: number;
    multiplier: number;
  } | null;
  /** The viewer has armed the straddle for their next under-the-gun turn. */
  youStraddleNext: boolean;

  /** Run It Twice state for NLHE cash tables that offer it (ADR-0028); `null`
   * when the table doesn't. `armed` is true when this hand is set to run two
   * boards on an all-in run-out (every dealt-in player had it on at the deal). */
  runItTwice: { enabled: boolean; armed: boolean } | null;
  /** The viewer has armed "run it twice". */
  youRunItTwice: boolean;
}

/** One entry of the hand event stream, forwarded to clients as `hand:update`. */
export interface HandUpdateEvent {
  type: string;
  /** Engine event payload, already stripped of anything the recipient must not see. */
  [key: string]: unknown;
}

export interface TableChatMessage {
  tableId: string;
  seatNumber: number | null;
  userId: string;
  username: string;
  text: string;
  at: string;
}

export interface TableTimeChargeMessage {
  tableId: string;
  seatNumber: number;
  /** Chips actually taken - may be less than the table's rate if it's all the seat had left. */
  amount: number;
}

export interface WsError {
  code: string;
  message: string;
}
