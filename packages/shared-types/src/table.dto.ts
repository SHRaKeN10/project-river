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
}

export interface PotView {
  amount: number;
  eligibleSeats: number[];
}

export interface TableStateView {
  tableId: string;
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
