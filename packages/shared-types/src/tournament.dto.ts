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

  /** Epoch millis the level clock started, or null before RUNNING. */
  startedAt: number | null;
  /** Level in effect right now (1-indexed), or null before RUNNING. */
  currentLevel: number | null;
  /** Epoch millis the current level ends, or null. */
  levelEndsAt: number | null;

  /** The requesting user's own registration, if any. */
  you: TournamentEntryView | null;
  /** Present once FINISHED: standings, best first. */
  results: { userId: string; username: string; position: number; payout: number }[] | null;
}
