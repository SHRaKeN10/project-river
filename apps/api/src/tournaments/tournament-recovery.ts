import type { GameState, PreviousPositions, TableConfig } from '@river/poker-engine';

/**
 * The on-restart recovery contract for a running tournament.
 *
 * Source-of-truth split (see ADR-0025):
 *   - Postgres  = durable identity / config / clock anchor / settlement
 *                 (`Tournament.status/startedAt/pausedMs/pausedAt/resultsJson`,
 *                 `TournamentEntry.finishPosition/payout/eliminatedAt`). The
 *                 `TournamentEntry.stack` column is a *denormalised cache* for
 *                 the REST view and is NOT read back on recovery.
 *   - Redis     = one key `tournament:<id>:snapshot`, this blob - the single
 *                 authoritative runtime checkpoint. There is no second runtime
 *                 source, so a crash can never leave "Redis says X, Postgres
 *                 says Y" for anything that matters to resuming play.
 *
 * The blob is a flat data snapshot (never class instances / timers). The
 * in-progress hand rides in each table's `GameState`, which the engine
 * guarantees is a complete, self-contained resume point - no event replay is
 * needed to continue a hand.
 */

/** Bump on any incompatible shape change. A snapshot with a different version
 * is rejected (recovery fails closed) rather than misread. */
export const TOURNAMENT_SNAPSHOT_VERSION = 1;

export interface TournamentTableSnapshot {
  tableId: string;
  label: string;
  gameType: string;
  /** Blinds/ante in force for the current hand, and queued for the next. */
  engineConfig: TableConfig;
  pendingConfig: TableConfig;
  /** The authoritative hand state - deck order + cursor, board, betting round,
   * contributions, street, acting seat. Server-side only, never sent to a
   * client (the gateway projects it per viewer). */
  state: GameState;
  handNumber: number;
  previousPositions: PreviousPositions | null;
  /** Per-user client-sequence high-water marks - stale/duplicate action
   * protection must survive the restart. */
  lastSeqByUser: [string, number][];
  revealedSeats: number[];
  paused: boolean;
  held: boolean;
  handStartStacks: [number, number][];
  seats: {
    seat: number;
    userId: string;
    username: string;
    avatarUrl: string | null;
    /** Always written false; every seat is disconnected until its client
     * reconnects after the restart. */
    connected: boolean;
    stack: number;
  }[];
}

export interface TournamentEntrySnapshot {
  entryId: string;
  userId: string;
  username: string;
  avatarUrl: string | null;
  stack: number;
  finishPosition: number | null;
  tableId: string | null;
  pendingBust: { stackAtHandStart: number } | null;
}

export interface TournamentSnapshot {
  v: number;
  tournamentId: string;
  /** Which `START_HAND`-era run this snapshot belongs to - cross-checked
   * against `Tournament.startedAt` so a snapshot from an earlier run of the
   * same id can't be misapplied. */
  startedAtMs: number;
  /** Wall clock when this checkpoint was written (observability + staleness). */
  writtenAtMs: number;
  /** Monotonic checkpoint counter within a process. */
  seq: number;
  /** `running` while the tournament plays; `finished` is a short-lived marker
   * left after settlement so a late client reconnect can still be told. */
  phase: 'running' | 'finished';

  // coordinator scalars
  schedule: unknown; // BlindSchedule (kept `unknown` to avoid a shared-types dep here)
  entrants: number;
  startingStack: number;
  seatsPerTable: number;
  prizePool: number;
  paidPlaces: number;
  name: string;
  gameType: string;
  eliminatedCount: number;
  roundNumber: number;
  chopGroups: number[][];
  handForHand: boolean;

  entries: TournamentEntrySnapshot[];
  tables: TournamentTableSnapshot[];

  /** Present only when `phase === 'finished'`. */
  results?: { userId: string; position: number; payout: number }[];
}

/** Thrown by the runner's `resumeFromSnapshot` when the blob cannot be trusted
 * to reconstruct authoritative state. Recovery catches it, logs loudly, and
 * leaves the tournament untouched (no runner, still RUNNING - a human decides). */
export class TournamentRecoveryError extends Error {
  constructor(
    readonly tournamentId: string,
    readonly detail: string,
  ) {
    super(`tournament ${tournamentId} recovery failed: ${detail}`);
    this.name = 'TournamentRecoveryError';
  }
}
