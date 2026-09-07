import { Injectable, Logger } from '@nestjs/common';

export interface ErrorContext {
  /** Coarse area the failure came from, e.g. 'http', 'tournament-runner'. */
  scope: string;
  /** Anything useful for triage - request id, table id, user id, etc. */
  [key: string]: unknown;
}

/**
 * The seam between "something went wrong" and wherever errors are collected.
 * The default implementation writes a structured log line (picked up by the
 * Fly log stream / any drain). {@link SentryErrorReporter} adds Sentry on top
 * when `SENTRY_DSN` is configured. Tests inject a fake.
 */
export abstract class ErrorReporter {
  abstract capture(error: unknown, context: ErrorContext): void;
}

@Injectable()
export class LoggingErrorReporter extends ErrorReporter {
  private readonly logger = new Logger('ErrorReporter');

  capture(error: unknown, context: ErrorContext): void {
    const err = error instanceof Error ? error : new Error(String(error));
    const { scope, ...rest } = context;
    this.logger.error(
      {
        event: 'error_captured',
        scope,
        detail: rest,
        err: { name: err.name, message: err.message },
      },
      err.stack,
    );
  }
}
