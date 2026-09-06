import { z } from 'zod';
import { playerActionSchema } from './table.dto';

/** One level of a tournament's blind structure (mirrors the engine's BlindLevel). */
export const blindLevelSchema = z.object({
  level: z.number().int().positive(),
  smallBlind: z.number().int().nonnegative(),
  bigBlind: z.number().int().nonnegative(),
  ante: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
  isBreak: z.boolean(),
});
export type BlindLevelWire = z.infer<typeof blindLevelSchema>;

export const createTournamentSchema = z.object({
  name: z.string().min(1).max(80),
  gameType: z.enum(['NLHE', 'PLO', 'OMAHA5_HILO']).optional(),
  buyIn: z.number().int().positive(),
  entryFee: z.number().int().nonnegative().optional(),
  startingStack: z.number().int().positive(),
  seatsPerTable: z.number().int().min(2).max(9).optional(),
  blinds: z.array(blindLevelSchema).min(1),
  lateRegUntilLevel: z.number().int().positive().optional(),
  maxEntrants: z.number().int().min(2).nullable().optional(),
});
export type CreateTournamentInput = z.infer<typeof createTournamentSchema>;

/** Admin lifecycle transitions. `REGISTERING` opens sign-ups pre-start;
 * `RUNNING` draws seats and starts the clock; `CANCELLED` refunds every
 * entrant. `PAUSED` / `FINISHED` are driven by the runner, not this endpoint. */
export const setTournamentStatusSchema = z.object({
  status: z.enum(['REGISTERING', 'RUNNING', 'CANCELLED']),
});

// --- WebSocket contracts ---------------------------------------------------

export const tournamentWatchSchema = z.object({ tournamentId: z.string().uuid() });
export type TournamentWatchPayload = z.infer<typeof tournamentWatchSchema>;

export const tournamentActionSchema = z.object({
  tournamentId: z.string().uuid(),
  handId: z.string().min(1),
  /** Client-supplied monotonic id for de-duping double taps / reconnect resends. */
  clientSeq: z.number().int().nonnegative(),
  action: playerActionSchema,
});
export type TournamentActionPayload = z.infer<typeof tournamentActionSchema>;

/**
 * `tournament:clock` - the authoritative level-clock snapshot. The server sends
 * one on watch, on every blind-level change, and after each hand-for-hand round
 * (when the field / table count / hand-for-hand flag may have moved). The client
 * renders a *local* countdown from `levelEndsAt` and only re-synchronises when a
 * fresh snapshot arrives - there is no per-second server broadcast.
 *
 * `serverNow` is the server's wall clock at the moment the snapshot was taken;
 * the client corrects its own countdown for clock skew against it rather than
 * trusting its device clock.
 */
export interface TournamentClockState {
  tournamentId: string;
  /** Level in effect right now (1-indexed). */
  level: number;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  /** The current level is a scheduled break (no hands run). */
  isBreak: boolean;
  /** Epoch millis the current level ends (the next begins); null on the final
   * level, which runs until the tournament ends. */
  levelEndsAt: number | null;
  /** The current level's configured length. */
  levelDurationMs: number;
  /** Server epoch millis when this snapshot was taken (skew reference). */
  serverNow: number;
  /** Hand-for-hand play is active (at/near the money bubble). */
  handForHand: boolean;
  /** Players still holding chips. */
  playersLeft: number;
  /** How many places are paid. */
  placesPaid: number;
  /** Live table count. */
  tableCount: number;
}

/** `tournament:assignment` - your table / seat in a tournament. */
export interface TournamentAssignment {
  tournamentId: string;
  tableId: string;
  seat: number;
}

/** `tournament:eliminated`. */
export interface TournamentElimination {
  tournamentId: string;
  finishPosition: number;
}

/** `tournament:finished`. */
export interface TournamentFinished {
  tournamentId: string;
  results: { userId: string; position: number; payout: number }[];
}

export interface TournamentEntryView {
  userId: string;
  username: string;
  registeredAt: string;
  stack: number;
  eliminated: boolean;
  finishPosition: number | null;
  payout: number;
  /** Present once the tournament is RUNNING: where this player currently sits. */
  tableId?: string | null;
  seat?: number | null;
}

export interface TournamentView {
  id: string;
  name: string;
  gameType: string;
  status: string;
  buyIn: number;
  entryFee: number;
  startingStack: number;
  seatsPerTable: number;
  blinds: BlindLevelWire[];
  lateRegUntilLevel: number;
  maxEntrants: number | null;

  entrantCount: number;
  /** Players still holding chips (0 or 1 once finished). */
  playersLeft: number;
  prizePool: number;
  placesPaid: number;
  /** The prize ladder for the current field, best place first; `[]` under two
   * entrants. Comes from the API because the mobile client has no engine. */
  payouts: number[];

  /** Sign-ups are open (pre-start and under the entrant cap). */
  registrationOpen: boolean;
  /** The requesting user can still cancel their registration (pre-start). */
  canUnregister: boolean;

  /** Epoch millis the level clock started, or null before RUNNING. */
  startedAt: number | null;
  /** The authoritative level clock, or null before RUNNING. */
  clock: TournamentClockState | null;

  /** The requesting user's own registration, if any. */
  you: TournamentEntryView | null;
  /** Present once FINISHED: standings, best first. */
  results: { userId: string; username: string; position: number; payout: number }[] | null;
}
