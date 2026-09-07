# ADR-0035: Seat-write races (the flaky rejoin e2e)

Status: Accepted — 2026-09-07 (bug fix — feature-freeze exception)

## Context

`poker-gateway.e2e "honours a rejoined player's actions"` failed ~2 of 3 CI
runs and was behind every recent "CI failed" email. Investigation (Postgres
`log_lock_waits` + a temporary log line in `sitDown`) found **two unrelated
problems**, neither a production defect:

### 1. The test contradicted anti-ratholing (ADR-0029)

Player A joins with `buyIn: 1000`, plays one heads-up hand, ends with ~1020
chips (won the blinds), leaves, then rejoins the same seat with `buyIn: 1000`.
Anti-ratholing (ADR-0029, added later) correctly rejects a rebuy below the
stack you left with, for 30 minutes. `sitDown` throws, the gateway swallows it
into `{ error }`, and the ack's `.ok` is `undefined`. Flaky because hand 1's
outcome is random: A ends > 1000 → blocked → fail; A ends ≤ 1000 → allowed →
pass. Every table gets `antiRatholeMinutes: 30` from the schema default. The
test predates ADR-0029 and was never updated.

### 2. A test-only Postgres deadlock

Every 40P01 in the Postgres log history is the same pair:

| transaction                                                         | lock order                                  |
| ------------------------------------------------------------------- | ------------------------------------------- |
| `syncSeats` (a roster snapshot)                                     | seat rows → the `PokerTable` row            |
| `DELETE FROM "PokerTable" WHERE id IN (…)` (e2e `afterAll` cleanup) | the `PokerTable` row → cascade to seat rows |

Opposite order → deadlock. **Production never deletes a `PokerTable` row**
(admin "close" is a status change), and the soak's 22,000 prod hands hit zero
deadlocks. It only happens because the e2e teardown hard-deletes tables while a
`TableRunner` is still flushing a fire-and-forget roster snapshot. When it
fires mid-test it can abort A's `standUp` before the `TableDeparture` row is
written — which is why the test sometimes _passed_ despite problem 1.

## Decision

1. **Test fix.** The rejoin test runs on a table with `antiRatholeMinutes: 0`
   (a new `makeTable` knob) — it isn't exercising anti-ratholing. Post-gameplay
   seat reads across the suite go through a `seatRows()` helper that first
   `await`s `TableManager.settleSeatChanges` (this also fixed a latent flake in
   the straddle and run-it-twice tests, which read a `syncSeats`-written flag).

2. **`TableManager.drain()`.** Stops every runner and waits out its in-flight
   `PokerTableSeat` writes, bounded at 5 s. `onModuleDestroy` calls it — a real
   improvement: a rolling deploy no longer abandons a half-written roster. Every
   e2e teardown calls it before `DELETE FROM PokerTable`, so a lagging
   `syncSeats` can't race the cascade.

3. **Deadlock backstop.** `syncSeats` retries on 40P01 only (Prisma `P2034` or a
   raw `deadlock detected` message), 4 attempts, 20/40/80 ms backoff. Never
   retries any other error. Prod can't reach the deadlock, but the retry costs
   nothing and closes the gap for good.

## Consequences

- No production behaviour change. No table-runner or seat-management redesign.
- `TableManager.onModuleDestroy` is now async (awaits the drain).
- New: `retryOnDeadlock` / `isDeadlock` in `tables.service.ts` (+ unit tests);
  `TableManager.drain()`; a regression e2e that races `syncSeats` against a
  cascade `DELETE` and asserts no 40P01 escapes.
