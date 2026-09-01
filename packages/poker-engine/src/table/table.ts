import { isInHand, type PlayerState, PlayerStatus } from '../player/player';

export interface TableConfig {
  /** 2 to 9. */
  readonly maxSeats: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  /** Per-player ante. 0 for the MVP. */
  readonly ante: number;
  readonly minBuyIn: number;
  readonly maxBuyIn: number;
}

export function createTableConfig(overrides: Partial<TableConfig> = {}): TableConfig {
  const bigBlind = overrides.bigBlind ?? 20;
  const smallBlind = overrides.smallBlind ?? Math.floor(bigBlind / 2);
  const config: TableConfig = {
    maxSeats: overrides.maxSeats ?? 9,
    smallBlind,
    bigBlind,
    ante: overrides.ante ?? 0,
    minBuyIn: overrides.minBuyIn ?? bigBlind * 20,
    maxBuyIn: overrides.maxBuyIn ?? bigBlind * 200,
  };
  validateTableConfig(config);
  return config;
}

export function validateTableConfig(config: TableConfig): void {
  if (config.maxSeats < 2 || config.maxSeats > 9) {
    throw new Error(`maxSeats must be between 2 and 9, got ${config.maxSeats}`);
  }
  if (config.smallBlind <= 0 || config.bigBlind <= 0) {
    throw new Error('blinds must be positive');
  }
  if (config.smallBlind > config.bigBlind) {
    throw new Error('smallBlind cannot exceed bigBlind');
  }
  if (config.ante < 0) throw new Error('ante cannot be negative');
  if (config.minBuyIn > config.maxBuyIn) throw new Error('minBuyIn cannot exceed maxBuyIn');
}

/** Seats (ascending) that will be dealt into the next hand: seated, not sitting
 * out or eliminated, and with chips behind. */
export function seatsForNextHand(players: readonly PlayerState[]): number[] {
  return players
    .filter(
      (p) =>
        p.stack > 0 && p.status !== PlayerStatus.SittingOut && p.status !== PlayerStatus.Eliminated,
    )
    .map((p) => p.seatNumber)
    .sort((a, b) => a - b);
}

/** Seats still contesting the current hand (ACTIVE or ALL_IN), ascending. */
export function contestingSeats(players: readonly PlayerState[]): number[] {
  return players
    .filter(isInHand)
    .map((p) => p.seatNumber)
    .sort((a, b) => a - b);
}

/** The next seat after `fromSeat` in the (ascending, wrapping) list. `fromSeat`
 * need not itself be in the list. */
export function nextSeat(fromSeat: number, seats: readonly number[]): number {
  if (seats.length === 0) throw new Error('no seats to advance to');
  const ahead = seats.find((s) => s > fromSeat);
  const next = ahead ?? seats[0];
  if (next === undefined) throw new Error('no seats to advance to');
  return next;
}

export function isHeadsUp(seats: readonly number[]): boolean {
  return seats.length === 2;
}

export interface Positions {
  readonly buttonSeat: number;
  readonly smallBlindSeat: number;
  readonly bigBlindSeat: number;
  /** Seat that acts first pre-flop (UTG; the button in heads-up). */
  readonly firstToActPreflop: number;
}

/**
 * Assigns button and blinds for the next hand.
 *
 * Uses the common "moving button" simplification: the button advances to the
 * next eligible seat, the small blind is the next eligible seat after the
 * button, and the big blind the next after that. Full dead-button / dead-small-
 * blind rules are a later refinement (they only matter for exact cash-game
 * fairness across sit-downs).
 *
 * Heads-up: the button posts the small blind and acts first pre-flop.
 */
export function assignPositions(
  seats: readonly number[],
  previousButtonSeat: number | null,
): Positions {
  if (seats.length < 2) {
    throw new Error(`need at least 2 players to start a hand, got ${seats.length}`);
  }
  const ordered = [...seats].sort((a, b) => a - b);

  const buttonSeat =
    previousButtonSeat === null ? (ordered[0] as number) : nextSeat(previousButtonSeat, ordered);

  if (isHeadsUp(ordered)) {
    const bigBlindSeat = nextSeat(buttonSeat, ordered);
    return {
      buttonSeat,
      smallBlindSeat: buttonSeat,
      bigBlindSeat,
      firstToActPreflop: buttonSeat,
    };
  }

  const smallBlindSeat = nextSeat(buttonSeat, ordered);
  const bigBlindSeat = nextSeat(smallBlindSeat, ordered);
  const firstToActPreflop = nextSeat(bigBlindSeat, ordered);
  return { buttonSeat, smallBlindSeat, bigBlindSeat, firstToActPreflop };
}

/** First contesting seat clockwise from the button (post-flop first-to-act). */
export function firstToActPostflop(
  buttonSeat: number,
  contesting: readonly number[],
): number | null {
  if (contesting.length === 0) return null;
  const ordered = [...contesting].sort((a, b) => a - b);
  return nextSeat(buttonSeat, ordered);
}
