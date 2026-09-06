import { Injectable } from '@nestjs/common';
import { ErrorContext, LoggingErrorReporter } from './error-reporter';
import { Sentry } from './instrument';

/**
 * Structured logging (via the base class) *plus* Sentry. Only wired in when
 * `SENTRY_DSN` is set - see {@link observability.module}. If Sentry was never
 * initialised the `captureException` call is a documented no-op, so this is
 * safe even if the DSN check and the SDK ever disagree.
 */
@Injectable()
export class SentryErrorReporter extends LoggingErrorReporter {
  override capture(error: unknown, context: ErrorContext): void {
    super.capture(error, context);
    const err = error instanceof Error ? error : new Error(String(error));
    const { scope, ...rest } = context;
    Sentry.captureException(err, { tags: { scope }, extra: rest });
  }
}
