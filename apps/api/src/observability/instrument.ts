/**
 * Sentry bootstrap. This file is imported *first* from `main.ts` - before Nest
 * and before any app code - so the SDK can instrument the runtime.
 *
 * No `SENTRY_DSN` in the environment => `Sentry.init` is never called and the
 * whole SDK stays inert (every `captureException` becomes a no-op). Development,
 * tests and CI therefore need no Sentry account and behave exactly as before.
 *
 * This reads `process.env` directly rather than the validated config service,
 * which does not exist yet at import time.
 */
import * as Sentry from '@sentry/node';

const dsn = process.env.SENTRY_DSN?.trim();

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT?.trim() || process.env.NODE_ENV || 'development',
    // Tracing is opt-in and off by default - this deployment is one small
    // machine and we only want error signal for now.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0) || 0,
    // Never let request headers / bodies carry credentials into Sentry.
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request?.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.cookie;
      }
      if (event.request?.data && typeof event.request.data === 'object') {
        for (const k of ['password', 'refreshToken', 'accessToken', 'token']) {
          if (k in (event.request.data as Record<string, unknown>)) {
            (event.request.data as Record<string, unknown>)[k] = '[redacted]';
          }
        }
      }
      return event;
    },
  });
}

export const sentryEnabled = Boolean(dsn);
export { Sentry };
