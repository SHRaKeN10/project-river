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
  /** May be an empty seat (a "dead button") when the previous button's seat
   * emptied - `deadButton` says which. */
  readonly buttonSeat: number;
  /** null = "dead small blind": no small blind is posted this hand. */
  readonly smallBlindSeat: number | null;
  /** Always a live player. */
  readonly bigBlindSeat: number;
  /** Seat that acts first pre-flop (UTG; the button in heads-up). */
  readonly firstToActPreflop: number;
  readonly deadButton: boolean;
}

/** What the previous hand's positions were - needed for correct rotation. */
export interface PreviousPositions {
  readonly buttonSeat: number;
  readonly smallBlindSeat: number | null;
  readonly bigBlindSeat: number;
}

/** Snapshot the button/blind seats of a finished hand into the shape
 * `START_HAND` needs for the next hand's rotation. */
export function previousPositionsOf(state: {
  readonly buttonSeat: number;
  readonly smallBlindSeat: number | null;
  readonly bigBlindSeat: number;
}): PreviousPositions {
  return {
    buttonSeat: state.buttonSeat,
    smallBlindSeat: state.smallBlindSeat,
    bigBlindSeat: state.bigBlindSeat,
  };
}

/**
 * Assigns button and blinds for the next hand using the **forward-moving big
 * blind** rule (as used by every major online cash game):
 *
 *  - The big blind advances by exactly one live player each hand - so every
 *    player posts the big blind the same number of times, in order, and no one
 *    can dodge it by sitting out.
 *  - The small blind is whoever posted the big blind last hand, if still seated;
 *    otherwise there is a **dead small blind** (none is posted).
 *  - The button is whoever posted the small blind last hand, if still seated;
 *    otherwise the previous button if still seated; otherwise the (empty) seat
 *    just before the small blind - a **dead button**.
 *
 * Heads-up: the button is the small blind, acts first pre-flop, and alternates
 * every hand.
 */
export function assignPositions(
  seats: readonly number[],
  previous: PreviousPositions | null,
  maxSeats: number,
): Positions {
  if (seats.length < 2) {
    throw new Error(`need at least 2 players to start a hand, got ${seats.length}`);
  }
  const ordered = [...seats].sort((a, b) => a - b);
  const isOccupied = (seat: number): boolean => ordered.includes(seat);

  if (isHeadsUp(ordered)) {
    const [a, b] = ordered as [number, number];
    const button =
      previous === null ? a : previous.buttonSeat === a ? b : previous.buttonSeat === b ? a : a;
    const bigBlindSeat = button === a ? b : a;
    return {
      buttonSeat: button,
      smallBlindSeat: button,
      bigBlindSeat,
      firstToActPreflop: button,
      deadButton: false,
    };
  }

  if (previous === null) {
    const buttonSeat = ordered[0] as number;
    const smallBlindSeat = nextSeat(buttonSeat, ordered);
    const bigBlindSeat = nextSeat(smallBlindSeat, ordered);
    return {
      buttonSeat,
      smallBlindSeat,
      bigBlindSeat,
      firstToActPreflop: nextSeat(bigBlindSeat, ordered),
      deadButton: false,
    };
  }

  // forward-moving big blind
  const bigBlindSeat = nextSeat(previous.bigBlindSeat, ordered);

  // small blind = last hand's big blind, if still seated
  const smallBlindSeat = isOccupied(previous.bigBlindSeat) ? previous.bigBlindSeat : null;

  // button = last hand's small blind if seated; else last hand's button if
  // seated; else the (empty) seat just before the small/big blind.
  const anchor = smallBlindSeat ?? bigBlindSeat;
  let buttonSeat: number;
  if (
    previous.smallBlindSeat !== null &&
    isOccupied(previous.smallBlindSeat) &&
    previous.smallBlindSeat !== bigBlindSeat &&
    previous.smallBlindSeat !== smallBlindSeat
  ) {
    buttonSeat = previous.smallBlindSeat;
  } else if (
    isOccupied(previous.buttonSeat) &&
    previous.buttonSeat !== bigBlindSeat &&
    previous.buttonSeat !== smallBlindSeat
  ) {
    buttonSeat = previous.buttonSeat;
  } else {
    buttonSeat = (anchor - 1 + maxSeats) % maxSeats;
  }

  return {
    buttonSeat,
    smallBlindSeat,
    bigBlindSeat,
    firstToActPreflop: nextSeat(bigBlindSeat, ordered),
    deadButton: !isOccupied(buttonSeat),
  };
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
