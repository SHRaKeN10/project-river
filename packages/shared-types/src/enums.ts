/**
 * Cross-cutting enums shared by the API, mobile app, admin dashboard and the
 * poker engine's public contract. Keep this file free of runtime dependencies.
 */

export enum Suit {
  SPADES = 'SPADES',
  HEARTS = 'HEARTS',
  DIAMONDS = 'DIAMONDS',
  CLUBS = 'CLUBS',
}

export enum Rank {
  TWO = 'TWO',
  THREE = 'THREE',
  FOUR = 'FOUR',
  FIVE = 'FIVE',
  SIX = 'SIX',
  SEVEN = 'SEVEN',
  EIGHT = 'EIGHT',
  NINE = 'NINE',
  TEN = 'TEN',
  JACK = 'JACK',
  QUEEN = 'QUEEN',
  KING = 'KING',
  ACE = 'ACE',
}

export enum GameType {
  /** No-Limit Texas Hold'em. */
  NLHE = 'NLHE',
  /** Pot-Limit Omaha (four hole cards). */
  PLO = 'PLO',
  /** "Big O" - five-card Pot-Limit Omaha, eight-or-better hi/lo split. */
  OMAHA5_HILO = 'OMAHA5_HILO',
}

/** Human label for a game type, for headers and the lobby. */
export const GAME_TYPE_LABEL: Readonly<Record<GameType, string>> = {
  [GameType.NLHE]: "No-Limit Hold'em",
  [GameType.PLO]: 'Pot-Limit Omaha',
  [GameType.OMAHA5_HILO]: 'Big O (Hi-Lo)',
};

/** Short tag for the lobby card (empty for the default Hold'em). */
export const GAME_TYPE_TAG: Readonly<Record<GameType, string>> = {
  [GameType.NLHE]: '',
  [GameType.PLO]: 'PLO',
  [GameType.OMAHA5_HILO]: 'Big O',
};

/** Hole cards dealt per player, by game type. */
export const GAME_HOLE_CARDS: Readonly<Record<GameType, number>> = {
  [GameType.NLHE]: 2,
  [GameType.PLO]: 4,
  [GameType.OMAHA5_HILO]: 5,
};

/** Game types played pot-limit (the raise ceiling is the pot). */
export const POT_LIMIT_GAME_TYPES: ReadonlySet<GameType> = new Set([
  GameType.PLO,
  GameType.OMAHA5_HILO,
]);

export enum Street {
  WAITING = 'WAITING',
  PREFLOP = 'PREFLOP',
  FLOP = 'FLOP',
  TURN = 'TURN',
  RIVER = 'RIVER',
  SHOWDOWN = 'SHOWDOWN',
  COMPLETE = 'COMPLETE',
}

export enum PlayerStatus {
  WAITING = 'WAITING',
  ACTIVE = 'ACTIVE',
  FOLDED = 'FOLDED',
  ALL_IN = 'ALL_IN',
  SITTING_OUT = 'SITTING_OUT',
  DISCONNECTED = 'DISCONNECTED',
  ELIMINATED = 'ELIMINATED',
}

export enum PlayerActionType {
  FOLD = 'FOLD',
  CHECK = 'CHECK',
  CALL = 'CALL',
  BET = 'BET',
  RAISE = 'RAISE',
  ALL_IN = 'ALL_IN',
  SIT_OUT = 'SIT_OUT',
  RETURN = 'RETURN',
}

export enum TableStatus {
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  CLOSED = 'CLOSED',
}

export enum UserRole {
  PLAYER = 'PLAYER',
  ADMIN = 'ADMIN',
}

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  BANNED = 'BANNED',
  DELETED = 'DELETED',
}
