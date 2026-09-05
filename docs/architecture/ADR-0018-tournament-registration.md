# ADR-0018: Tournament registration and pre-start lifecycle

Status: Accepted — 2026-09-05 (Phase 2, follow-up to ADR-0017)

## Context

ADR-0017 landed the pure tournament maths in the engine. This PR is the API
foundation the tournament runner will sit on: the durable model, the
registration flow (with the wallet debit), and the pre-start lifecycle. It does
**not** start any tournament or play any hands - `RUNNING` / `PAUSED` /
`FINISHED` and the per-table runners arrive in the next PR.

## Decisions

### Model

`Tournament` holds the config (blinds as a `BlindLevel[]` JSON blob, mirroring
the engine type), a `TournamentStatus`, a level-clock bookmark
(`startedAt` / `pausedMs` / `pausedAt` - all null/zero until the runner starts
it), and a `resultsJson` filled in at the end. `TournamentEntry` is one player's
registration plus the live state the runner will maintain (`stack`,
`seatTableId` / `seatNumber`, `eliminatedAt`, `finishPosition`, `payout`).

`ChipMovementReason` gains `TOURNAMENT_BUYIN`, `TOURNAMENT_REFUND`,
`TOURNAMENT_PAYOUT` (the last unused until payouts land).

### The clock helper

`tournament-clock.ts` turns the persisted bookmark into answers:
`elapsedRunningMs` (real time minus every pause, including the current one),
`currentLevel` (delegates to the engine's `blindLevelAt`), `levelEndsAt` (the
wall-clock time the next level begins, which a pause pushes back). Pure, `now`
passed in, unit-tested in isolation - the runner will call it on a timer.

### Registration

`POST /tournaments/:id/register` - allowed only while `SCHEDULED` or
`REGISTERING` (late registration during `RUNNING` is the runner's job). Checks
the entrant cap, refuses a double registration (409), then in **one
transaction** creates the entry and debits `buyIn + entryFee` from the wallet
via `ChipsService.move`. The chip movement's idempotency key is `tbuy:<entryId>`

- keyed on the fresh entry, not the `(tournament, user)` pair, so a player who
  unregisters and registers again is charged the second time.

`DELETE /tournaments/:id/register` - pre-start only; deletes the entry and
refunds `buyIn + entryFee` (`tref:<entryId>`), atomically.

`PATCH /tournaments/:id/status` (admin) - this PR handles
`SCHEDULED → REGISTERING` and `* → CANCELLED` (every entrant refunded,
`tcancel:<entryId>`, in one transaction). A cancelled tournament drops off the
list.

## Tests

- `tournament-clock.spec.ts` - elapsed time with accumulated and in-progress
  pauses; level tracking and boundaries; level-end wall time; the final level
  and pre-start have no end.
- `tournament.e2e-spec.ts` - admin-only creation, config validation (a
  nine-seat Big O tournament is rejected), the wallet debit on register, the
  full refund on unregister and on re-register being charged again, the
  double-registration conflict, the entrant cap, cancel-refunds-everyone, and
  the registration transition.

## Result

API unit **60** (+8), API e2e **43** (+7). Engine 366 and mobile 56 unchanged.
format / lint / typecheck / build clean.

## Deploy

`fly deploy` runs the migration (independent of the PLO/Big O enum migrations,
so their relative order does not matter).

## Next

The `TournamentRunner`: an actor that on start draws seats (`seatDraw`), creates
the poker tables and spins up `TableRunner`s with tournament chips as the stack,
runs the level clock, relays player actions, watches for bust-outs to record
`Elimination`s, and calls `planBalance` between hands. Then hand-for-hand bubble
play, payout settlement, the clock/registration UI, and a "3-table tournament
runs clean" bot soak.
