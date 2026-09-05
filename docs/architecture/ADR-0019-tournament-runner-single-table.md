# ADR-0019: The tournament runner (single-table)

Status: Accepted — 2026-09-05 (Phase 2, follow-up to ADR-0018)

## Context

ADR-0017 landed the pure tournament maths; ADR-0018 the API model and the
pre-start lifecycle. This PR is the runner itself - the actor that actually
plays a tournament out. It is deliberately **single-table**: it runs a field
that fits one table (`entrants <= seatsPerTable`) from the first hand to a
winner, with the level clock, bust-out tracking, and payout settlement.
Multi-table seating and `planBalance` are the next PR.

## Decisions

### A dedicated `TournamentTableRunner`, not the cash `TableRunner`

The cash-game `TableRunner` is load-tested and its wallet path is where real
value moves, so this PR does not touch it. `TournamentTableRunner` reuses the
same shape - a serial command queue, the `reduce()` bridge, an action clock -
but is tournament-flavoured:

- seats are **assigned** by the coordinator (`seat()` / `unseat()`), never
  bought in to; there is no buy-in range check;
- a busted stack (`0` after a hand) is reported to the coordinator and the
  seat is freed - **nothing is returned to a wallet**;
- blinds change between hands via `setLevel()` (applied at the next
  `START_HAND`, never mid-hand);
- a disconnected player gets the short action clock and is folded by timeout,
  but is **never stood up** - you only leave a tournament by busting;
- no time charges, no away-sweep, no chat, no hand-history persistence yet
  (hand history is a follow-up).

It emits `handComplete` (with a per-seat results snapshot and the busted
seats, worst-finish first) and `idle` (fewer than two players with chips, or
paused).

### The coordinator (`TournamentRunner`)

One per running tournament, owned by `TournamentManager`
(`Map<tournamentId, TournamentRunner>`, the same pattern as `TableManager`).
On `start()` it:

1. reads the entries, refuses a field that needs more than one table;
2. draws seats with `seatDraw`, stands up one `TournamentTableRunner` with the
   level-1 blinds and every entrant seated at `startingStack`;
3. flips the row to `RUNNING`, stamps `startedAt`, and starts the level clock
   (a timer that, on each level boundary, pushes the new blinds into the table
   and - on a break level - pauses it);
4. relays player actions (`act()`), and on every `handComplete`:
   - refreshes each live entry's `stack` from the hand's **own results
     snapshot** (not `table.stacks()`, which may already show the next hand's
     blinds by the time the async handler runs);
   - records each bust as a `finishPosition` on the `TournamentEntry`
     (`entrants - eliminatedSoFar`, smallest starting stack finishing worst -
     the same tie-break as the engine's `finishingOrder`), frees the seat;
   - when one player is left, settles: `payoutSchedule(entrants, prizePool)`,
     `ChipsService.move(+payout, TOURNAMENT_PAYOUT, tpay:<entryId>)` for each
     cashing finish, `resultsJson` written, status `FINISHED`.

Conservation invariant: the sum of every entry's stack is always
`startingStack * entrants` (asserted hand-by-hand in the tests).

### `PATCH /tournaments/:id/status` gains `RUNNING`

`SCHEDULED | REGISTERING -> RUNNING` (admin) hands off to
`TournamentManager.start`, which is the one place the row flips to `RUNNING`.
`* -> CANCELLED` now also stops the runner before refunding every entrant, so
no hand can complete (and no payout settle) during the refund.

## Known gaps (follow-ups)

- **Antes are not applied.** The blind schedule carries an `ante` per level and
  the runner passes it into the table config, but the poker engine's reducer
  does not post antes yet. Engine ante support is its own PR.
- **No restart recovery.** A process restart mid-tournament leaves the row
  `RUNNING` with no runner. Redis snapshot + rebuild lands with the multi-table
  work.
- **No gateway wiring.** Players cannot yet watch or act through a socket;
  the runner is driven by tests. The `PokerGateway` bridge, late registration,
  pause/resume, and the clock/registration UI are the next pieces.
- Multi-table seating, `planBalance` between hands, hand-for-hand bubble.

## Tests

- `tournament-table-runner.spec.ts` (5) - hands run and conserve chips, bust
  down to one with the idle signal; a new level only takes effect next hand; a
  busted player is not re-dealt and `unseat` is clean; a disconnected actor
  gets the short clock and is timed out but stays seated; stale-hand rejection.
- `tournament-runner.spec.ts` (4) - a 3-handed tournament to a winner with the
  finishing order and a one-place payout keyed on the winner's entry id;
  chip conservation asserted every hand of a 4-handed run; a nine-handed field
  pays two places, top-heavy, summing to the pool; a field that needs two
  tables is refused.
- `tournament.e2e-spec.ts` (+2) - the `RUNNING` transition draws seats, stamps
  the clock, and cannot be repeated; aborting a running tournament refunds
  everyone; a >1-table field is refused.

## Result

API unit **69** (+9), API e2e **45** (+2). Engine 366 and mobile 56 unchanged.
format / lint / typecheck / build clean.
