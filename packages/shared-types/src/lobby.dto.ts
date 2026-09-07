import { z } from 'zod';

/** One row in the lobby list. */
export interface LobbyTableView {
  id: string;
  name: string;
  gameType: string;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  maxSeats: number;
  seatedCount: number;
  openSeats: number;
  minBuyIn: number;
  maxBuyIn: number;
  /** Flat per-seat time charge, billed to the wallet (0 = none). Shown so a
   * player knows the fee before they sit, not just once seated. */
  timeChargeAmount: number;
  timeChargeIntervalMs: number;
  status: string;
  isPrivate: boolean;
  handInProgress: boolean;
  /** Mean pot over completed hands, rounded; 0 if none yet. */
  avgPot: number;
  handsPlayed: number;
  waitlistCount: number;
  /** For the requesting user. */
  isFavorite: boolean;
  onWaitlist: boolean;
  youAreSeated: boolean;
}

/** Query-string booleans: only the literal "true" is truthy. */
const queryBool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1')
  .optional();

export const lobbyFilterSchema = z.object({
  gameType: z.enum(['NLHE', 'PLO', 'OMAHA5_HILO']).optional(),
  minBigBlind: z.coerce.number().int().positive().optional(),
  maxBigBlind: z.coerce.number().int().positive().optional(),
  hasOpenSeat: queryBool,
  favoritesOnly: queryBool,
  includePrivate: queryBool,
});
export type LobbyFilter = z.infer<typeof lobbyFilterSchema>;

/** Compact live delta pushed to the `lobby` room. */
export interface LobbyTableDelta {
  id: string;
  seatedCount: number;
  openSeats: number;
  waitlistCount: number;
  handInProgress: boolean;
  avgPot: number;
  status: string;
}

export const LobbyClientToServer = {
  LOBBY_SUBSCRIBE: 'lobby:subscribe',
  LOBBY_UNSUBSCRIBE: 'lobby:unsubscribe',
} as const;

export const LobbyServerToClient = {
  LOBBY_TABLES: 'lobby:tables',
  LOBBY_UPDATE: 'lobby:update',
  /** Sent to the head of a table's waitlist when a seat is held for them
   * (ADR-0031). They have until `expiresAt` to claim it with a normal
   * `table:join` on `seatNumber`, after which the hold passes to the next in
   * line. */
  WAITLIST_SEAT_AVAILABLE: 'waitlist:seatAvailable',
} as const;

/** `waitlist:seatAvailable` payload. */
export interface WaitlistSeatAvailable {
  tableId: string;
  /** The specific seat held for this user. */
  seatNumber: number;
  /** Epoch millis the hold expires. */
  expiresAt: number;
}
