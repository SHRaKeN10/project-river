# ADR-0020: Multi-table tournaments

Status: Accepted — 2026-09-05 (Phase 2, follow-up to ADR-0019)

## Context

ADR-0019 landed the single-table `TournamentRunner`. This PR makes the
coordinator run **any number of tables**: it draws N tables, runs them in
parallel, and between hands breaks short tables and evens out the rest by
moving players - so a field of any size plays down to one winner. This is the
"a three-table tournament runs clean" milestone.

## Decisions

### The coordinator owns every table

`TournamentRunner` holds `Map<tableId, TournamentTableRunner>` (all in the one
API process). `start()` calls `seatDraw` and stands up one
`TournamentTableRunner` per resulting table, each with a `notify` closure that
tags its `tableId`. The level clock pushes new blinds into **every** table.

### Balancing between hands

`planBalance` (the engine, ADR-0017) needs a consistent, quiescent view, so the
real work runs only when **no table has a hand in progress**. Until then, every
table that IS between hands is `holdForBalance()`'d - a new "held" state,
separate from the break pause - so it can't run ahead of the laggard. When the
last table finishes, the coordinator:

1. disposes any table that emptied out (its last player busted);
2. holds all tables, builds the `TournamentTable[]` view from each table's
   `seatsArray()`, calls `planBalance`;
3. applies each move as `src.unseat(seat)` -> `dst.seat(...)` (the stack rides
   along);
4. disposes any table that is now empty - keyed on **actually empty**, not
   `plan.breakTableIds`, so a player is never dropped if a move could not land;
5. releases every remaining table (which reschedules its next hand).

A `balancing` guard makes the whole thing re-entrant-safe when several tables
finish close together.

### Heads-up multi-table is refused

`seatDraw` with `seatsPerTable = 2` and more than one table can't be balanced -
any bust leaves an odd live count that would need a one-player table. `start()`
rejects it (a single heads-up table is still fine). It also rejects the rare
field size that `seatDraw` itself can't seat without a one-player table.

### Finishing positions

A bust is recorded as `finishPosition = entrants - eliminatedSoFar` the moment
its `handComplete` is processed; within one hand, the smaller starting stack
finishes worse. **Across tables**, two busts in overlapping hands are ordered by
processing order, not chip count - real hand-for-hand bubble play (which freezes
this) is a follow-up.

## Known gaps (unchanged from ADR-0019, plus)

- No hand-for-hand bubble; no chops for exact ties.
- Balance can lag when tables desync badly (it waits for every table to be
  between hands). In practice tables realign often enough; a tighter
  per-table-pair balance is a possible refinement.
- Still no socket/gateway bridge, no antes (engine), no restart recovery.
- Player `connected` state is not preserved across a balance move (defaults to
  connected; the gateway will own this).

## Tests

- `tournament-runner.spec.ts` - the single-table cases from ADR-0019, plus:
  a **12-player / 3-table** field that balances, breaks down to a final table
  (`maxTables` 3 -> `minTables` 1), and pays two places; a **24-player /
  4-table** field run clean (every seat count 4..1 seen, no table over its cap,
  chips conserved every step, 24 distinct finishing positions, winner holds
  every chip); a heads-up multi-table field is refused.
- `tournament.e2e-spec.ts` - a 4-entrant / 3-per-table field starts as two
  tables; a heads-up multi-table field is refused (400).

## Result

API unit **71** (+1 net; the single-table "refuses" test became two multi-table
tests), API e2e **46** (+1). Engine 366 and mobile 56 unchanged.
format / lint / typecheck / build clean.

## Next

The socket/gateway bridge (players watch and act through the existing table
UI), then hand-for-hand bubble + chops, then the clock / registration screens
and a longer bot soak.
