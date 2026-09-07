# ADR-0030: API observability & structured errors

Status: Accepted — 2026-09-06 (Phase 3 — operations, ahead of human alpha)

## Context

Soak test #6 validated the deployed platform under load, chaos, and a mid-play
restart (see the soak report). The next step is human alpha testing — real
people on the single production machine. Two gaps make that risky:

1. **No error aggregation.** An unhandled rejection, a broken async handler in a
   coordinator, or a 500 is at best a line in the Fly log stream and at worst
   invisible. There is no "what is failing right now" surface.
2. **Inconsistent error shape.** Every throw site invents its own
   `BadRequestException('...')` string. Clients and log tooling have nothing
   stable to key on, and a non-`HttpException` bug leaks its message (and
   sometimes a stack) straight to the caller.

This ADR is deliberately scoped to _seeing_ failures. It does not sweep every
throw site onto typed errors (that is mechanical and can follow); it puts the
seam in place and converts the highest-signal handful.

## Decision

### 1. One global exception filter

`HttpExceptionFilter` (`APP_FILTER`) is the single place an error becomes an
HTTP response. Every failure leaves the API as:

```jsonc
{
  "statusCode": 404,
  "code": "NOT_FOUND", // stable, machine-readable — clients key off this
  "message": "table not found", // human text, unchanged from before
  "requestId": "1", // pino-http req.id, for log correlation
  "timestamp": "2026-09-06T18:00:00.000Z",
  "issues": [{ "path": "email", "message": "required" }], // only for VALIDATION_FAILED
}
```

- `AppError` subclasses carry their own `code`.
- Other `HttpException`s get a code mapped from the status
  (`400 → BAD_REQUEST`, `401 → UNAUTHORIZED`, …); a body carrying `issues` is
  tagged `VALIDATION_FAILED`.
- Anything that is **not** an `HttpException` is a bug: status 500, code
  `INTERNAL`, message `"Internal server error"` — the real error is logged and
  reported, never returned.

Logging: 4xx at `warn` (one line, no stack); 5xx and non-`HttpException` at
`error` with the stack, **and** sent to the `ErrorReporter`.

The envelope is backward compatible — `message` and `issues` stay at the top
level, so the existing clients and e2e assertions are unaffected.

### 2. `ErrorReporter` seam

```
abstract ErrorReporter { capture(error, context) }
  ├─ LoggingErrorReporter   — structured log line (always)
  └─ SentryErrorReporter    — the above + Sentry.captureException
```

The active implementation is chosen at wiring time: `SentryErrorReporter` when
`SENTRY_DSN` is set, otherwise `LoggingErrorReporter`. **No DSN in dev / test /
CI means Sentry is never initialised and the whole SDK is inert** — behaviour is
identical to before this change.

`instrument.ts` is imported first from `main.ts` (before Nest) so the SDK can
instrument the runtime when a DSN is present. `beforeSend` strips
`authorization` / `cookie` headers and redacts `password` / token fields from
request bodies; `sendDefaultPii` is off. Tracing is off unless
`SENTRY_TRACES_SAMPLE_RATE` is set — this is one small machine and we want error
signal only.

### 3. `OrchestrationErrorsService`

Failures that happen **outside a request** never reach the HTTP filter — a
broken `afterHand`, a checkpoint write that threw, a listener that blew up, a
recovery that failed closed. These now route through one service that logs,
reports, and **counts** them (`total`, `byScope`, `lastMessage`, `lastAt`).

Wired into:

| site                                        | scope                  |
| ------------------------------------------- | ---------------------- |
| `TournamentRunner.onOrchestrationError`     | `tournament-runner`    |
| `TournamentManager` listener catch          | `tournament-listener`  |
| `TournamentManager` recovery-scan / recover | `tournament-recovery*` |
| `TableManager` cashout-failed backstop      | `table-cashout`        |
| `TableManager` listener catch               | `table-listener`       |

`TournamentRunner` is not a Nest provider, so the service is passed in through
`TournamentRunnerDeps.onError` (absent in unit tests, which assert on the thrown
error directly — the runner still logs and swallows exactly as before).

### 4. Process-level guards

`main.ts` registers `unhandledRejection` (report) and `uncaughtException`
(report, flush Sentry, `exit(1)`). An uncaught exception leaves the process in
an unknown state; exiting lets Fly restart it clean, and restart recovery is
already covered by the Redis snapshot (ADR-0025 for tournaments; the cash
`TableManager` snapshot likewise).

### 5. Tournament-aware `/ops/metrics`

The soak found `handsLastMinute` reads zero during a tournament — tournament
hands are not persisted to `PokerHand`, and the figure is derived from that
table. Added:

```jsonc
"tournaments": { "running": 0, "playersRemaining": 0, "tables": 0, "handsLastMinute": 0 },
"orchestrationErrors": { "total": 0, "byScope": {}, "lastMessage": null, "lastAt": null }
```

`tournaments` is a roll-up over the live `TournamentRunner`s;
`tournaments.handsLastMinute` is an in-memory rolling count fed by
`TournamentRunner.onHandComplete`.

## Consequences

- Error responses have a new `code` / `requestId` / `timestamp`. Additive — no
  field was removed or renamed.
- `@sentry/node` is a new dependency. It is a no-op without a DSN.
- Coordinator failures are now visible on `/ops/metrics` and in Sentry, not just
  buried in logs.
- Follow-ups (not in this ADR): sweep the remaining `BadRequestException('...')`
  sites onto `AppError` codes; a Sentry release/environment convention; a
  Prometheus exporter over the same `/ops/metrics` numbers.
