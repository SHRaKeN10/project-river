# ADR-0010: Closing the known engine & auth limitations

Status: Accepted — 2026-09-01 (follow-up to ADR-0009, still before mobile UI)

## Context

ADR-0009 shipped with an honest limitations list in
`docs/poker-engine-test-report.md`. This ADR records how each was closed.

## Decisions

### Forward-moving big blind, dead button, dead small blind

`assignPositions(seats, previous, maxSeats)` replaces the old
`assignPositions(seats, previousButtonSeat)`. It now implements the standard
online cash-game rule:

- the **big blind advances by exactly one live player** every hand, so nobody
  can dodge it by sitting out and every seat posts it equally over an orbit;
- the small blind is last hand's big blind if still seated, otherwise there is a
  **dead small blind** (`Positions.smallBlindSeat: number | null`, none posted);
- the button is last hand's small blind if seated, else last hand's button if
  seated, else the empty seat just before the small blind — a **dead button**
  (`Positions.deadButton`).

`START_HAND` now carries `previousPositions: PreviousPositions | null` (button +
both blinds) instead of just the previous button seat. `GameState.smallBlindSeat`
and `HAND_STARTED.smallBlindSeat` are now `number | null`.

The application persists the three seats: `PokerTable.smallBlindSeat` /
`bigBlindSeat` columns were added (migration `…_forward_moving_blinds`), and the
Redis snapshot recovers them straight from the stored `GameState`.

### Auto-muck at showdown

`settleByShowdown` walks `showdownOrder` and a player **mucks** (emits
`HAND_MUCKED`, cards never revealed) when they called a river bet with chips
behind (`status ACTIVE`) and cannot beat or tie the best already-revealed hand
for **any pot they are eligible for**. All-in hands are always tabled, and if at
most one player could still wager the whole hand was all-in and every hand is
tabled. Pots are awarded from the revealed hands only.

### Disconnect grace timer

`TABLE_DISCONNECT_GRACE_MS` (default 10 s). `TableRunner.armActionTimer` uses
`min(grace, actionTimeout)` when the acting seat's socket is gone; `onConnected`
puts a returning player back on the full clock and a newly-dropped player on the
short one. Snapshot recovery no longer arms the timer at all — it waits for the
first reconnect (also handled in `onConnected`), so a fully-abandoned table
burns no timers.

### `PlayerStatus.Disconnected` removed from the engine

The engine never set it. Wire status is carried by the per-seat `connected:
boolean` in the projection; `@river/shared-types` keeps `PlayerStatus.DISCONNECTED`
for the wire contract only.

### Access-token revocation

`SessionBlocklistService` — a Redis denylist of revoked `sid`s with TTL =
access-token TTL. `revokeSession` (logout, refresh-reuse) and
`confirmPasswordReset` add to it; `JwtAuthGuard` and the socket auth middleware
check it. A Redis outage fails open — the short access-token TTL is the backstop
and refresh is always checked against the database.

### Bug found while hardening

The fuzz suite (below) caught a real chip leak: a `START_HAND` that could not
deal (fewer than two funded players) left the previous hand's `collectedPot` /
`pots` on the now-idle state, and `SIT_OUT` / `RETURN` could rewrite the status
of a player still in a live hand, corrupting settlement. Fixed: the idle
transition clears all hand state, `setStatus` rejects mid-hand changes for
players bound to the hand, and `settleByFold` never eats chips when there is no
eligible winner.

### New tests

- `table/table.test.ts` — forward-moving BB orbit fairness, dead button, dead SB.
- `reducer/showdown-muck.test.ts` — beaten caller mucks; all-in run-outs still
  table every hand; a muck for the main pot is still tabled to claim a side pot.
- `reducer/fuzz.test.ts` — ~20k deliberately malformed `EngineAction`s: `reduce`
  never throws, never mutates its input, conserves chips.
- `reducer/betting-scenarios.test.ts` — heads-up short stack below the SB;
  both blinds exceed a short all-in BB.
- `tables/table-runner.spec.ts` — grace clock on drop / full clock on return;
  timer re-armed on reconnect after snapshot recovery.
- `test/auth.e2e-spec.ts` — logout and password-reset kill the access token,
  not just the refresh token.

## Result

Engine: **26 suites / 267 tests** (sim ~18,900 hands). API: **33 unit + 19 e2e**.
The limitations list in `docs/poker-engine-test-report.md` is updated.
