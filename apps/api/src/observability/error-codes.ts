import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Stable, machine-readable error codes. These are part of the API contract:
 * clients and log tooling key off `code`, never off the human `message`.
 * Add codes here; never rename an existing one.
 */
export enum ErrorCode {
  // generic HTTP-shaped
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  BAD_REQUEST = 'BAD_REQUEST',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  RATE_LIMITED = 'RATE_LIMITED',
  INTERNAL = 'INTERNAL',

  // domain-specific (thrown as AppError subclasses)
  INSUFFICIENT_CHIPS = 'INSUFFICIENT_CHIPS',
  SEAT_TAKEN = 'SEAT_TAKEN',
  ALREADY_SEATED = 'ALREADY_SEATED',
  TABLE_NOT_OPEN = 'TABLE_NOT_OPEN',
  ANTI_RATHOLE_COOLDOWN = 'ANTI_RATHOLE_COOLDOWN',
  TOURNAMENT_NOT_RUNNING = 'TOURNAMENT_NOT_RUNNING',
  TOURNAMENT_REGISTRATION_CLOSED = 'TOURNAMENT_REGISTRATION_CLOSED',
}

/** Maps a raw HTTP status onto a generic code for non-`AppError` exceptions. */
export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return ErrorCode.BAD_REQUEST;
    case HttpStatus.UNAUTHORIZED:
      return ErrorCode.UNAUTHORIZED;
    case HttpStatus.FORBIDDEN:
      return ErrorCode.FORBIDDEN;
    case HttpStatus.NOT_FOUND:
      return ErrorCode.NOT_FOUND;
    case HttpStatus.CONFLICT:
      return ErrorCode.CONFLICT;
    case HttpStatus.TOO_MANY_REQUESTS:
      return ErrorCode.RATE_LIMITED;
    default:
      return status >= 500 ? ErrorCode.INTERNAL : ErrorCode.BAD_REQUEST;
  }
}

/**
 * A domain error that carries a stable {@link ErrorCode}. Extends
 * `HttpException` so Nest's pipeline treats it exactly like a built-in
 * exception; the global filter reads `.code` off it for the response envelope.
 */
export class AppError extends HttpException {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, status: HttpStatus = HttpStatus.BAD_REQUEST) {
    super({ message, code }, status);
    this.code = code;
  }
}

export class InsufficientChipsError extends AppError {
  constructor(message = 'insufficient chips') {
    super(ErrorCode.INSUFFICIENT_CHIPS, message, HttpStatus.BAD_REQUEST);
  }
}

export class SeatTakenError extends AppError {
  constructor(message = 'that seat is taken') {
    super(ErrorCode.SEAT_TAKEN, message, HttpStatus.CONFLICT);
  }
}

export class AlreadySeatedError extends AppError {
  constructor(message = 'you are already at this table') {
    super(ErrorCode.ALREADY_SEATED, message, HttpStatus.BAD_REQUEST);
  }
}

export class TableNotOpenError extends AppError {
  constructor(message = 'this table is not open') {
    super(ErrorCode.TABLE_NOT_OPEN, message, HttpStatus.BAD_REQUEST);
  }
}

export class AntiRatholeCooldownError extends AppError {
  constructor(message: string) {
    super(ErrorCode.ANTI_RATHOLE_COOLDOWN, message, HttpStatus.BAD_REQUEST);
  }
}

export class TournamentNotRunningError extends AppError {
  constructor(message = 'that tournament is not running') {
    super(ErrorCode.TOURNAMENT_NOT_RUNNING, message, HttpStatus.BAD_REQUEST);
  }
}

export class TournamentRegistrationClosedError extends AppError {
  constructor(message = 'registration is not open') {
    super(ErrorCode.TOURNAMENT_REGISTRATION_CLOSED, message, HttpStatus.BAD_REQUEST);
  }
}
