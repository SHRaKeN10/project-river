# ADR-0017: Tournament engine — the pure core

Status: Accepted — 2026-09-05 (Phase 2, "the full game menu" — the last piece)

## Context

Multi-table tournaments (MTTs) are the final Phase 2 deliverable and the biggest
one. Rather than one enormous change, this ADR sets the architecture and lands
the first, purely-computational slice.

### The split

The cash-game architecture already draws a clean line: the engine
(`@river/poker-engine`) is pure, deterministic, zero-dependency; the API's
`TableRunner` wraps `reduce()` with timers, sockets, and persistence. Tournaments
follow the same line:

- **Engine (`src/tournament/`, this PR)** — the pure decisions: what the blind
  level is at time _t_, how to draw the opening seats, how the prize pool splits,
  who finishes where, and which players move when tables need balancing. All
  deterministic functions, exhaustively unit-tested, no I/O.
- **API `TournamentRunner` (next PR)** — a single-writer actor, one per running
  tournament, that owns the level clock, holds a `Map<tableId, TableRunner>`,
  relays player actions, watches for bust-outs, and calls the engine functions to
  decide balancing and payouts. It persists to Postgres + Redis so a tournament
  survives an API restart mid-event.
- **Later PRs** — hand-for-hand bubble play; payout settlement + chops; the
  tournament clock UI and registration screens; the bot harness and a "3-table
  tournament runs clean" soak.

The one hard constraint carries over: the `TournamentRunner` and every
`TableRunner` it spawns live **in the same single API process**. This is fine
for one card room's online room; it is still not something you scale by adding
machines.

## What this PR adds

`packages/poker-engine/src/tournament/`:

| module               | exports                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `blind-schedule.ts`  | `BlindLevel`, `BlindSchedule`, `blindLevelAt(schedule, elapsedMs)`, `levelStartMs`, `totalScheduledMs`, `validateBlindSchedule`, `standardBlindSchedule(...)`                        |
| `seat-draw.ts`       | `seatDraw(playerIds, seatsPerTable, rng)` — even split, randomised, `ceil(n / seatsPerTable)` tables                                                                                 |
| `payouts.ts`         | `placesPaid(entrants)` (~top eighth), `payoutSchedule(entrants, prizePool)` — sums exactly, non-increasing, every place ≥ 1                                                          |
| `standings.ts`       | `Elimination`, `finishingOrder(eliminations, survivors)` — same-hand busts ordered by chips-at-hand-start; `bustedTogether` for chop detection                                       |
| `table-balancing.ts` | `planBalance(tables, seatsPerTable)` — break the shortest table while the field fits on the rest, otherwise move one player from the biggest to the smallest until the spread is ≤ 1 |
| `tournament.ts`      | `TournamentConfig`, `validateTournamentConfig`, `prizePool`, `totalTournamentChips`, `registrationOpen`                                                                              |

### Notable decisions

- **A break is a `BlindLevel` with `isBreak: true`** — no separate concept, and
  `blindLevelAt` still returns it so the clock UI can show "Break — 4:32".
- **`blindLevelAt` clamps past the end** rather than throwing: a real tournament
  keeps playing the top level until it finishes.
- **`payoutSchedule` reserves one chip per place, then shares the rest by a
  curve** (a hand-tuned percentage table for ≤ 9 places, geometric beyond), with
  the largest-remainder method placing the rounding chips. This makes the three
  invariants — exact sum, non-increasing, ≥ 1 each — hold for any field/pool,
  which a fuzz test checks across a wide range.
- **`planBalance` decides the structure; the coordinator picks the exact mover.**
  The engine has no button state, so it defaults to "the highest-seat player on
  the source table"; the `TournamentRunner` will substitute the player about to
  post the big blind so nobody skips one. Tests assert the post-conditions
  (tables level, right tables broken, every player still seated once), not the
  specific ids.
- **Finishing-position tiebreak**: two players all-in and busting in the same
  hand — the one who started that hand with more chips finishes higher (you
  outlast anyone you covered). Exactly equal covered stacks → `bustedTogether`
  is true and the two places' prize money is chopped by the coordinator.

## Tests

41 tests across the six modules: blind timing incl. boundaries and breaks; seat
draw evenness/determinism/rejection; the payout invariants under fuzz plus the
small-field curves; finishing order and the same-hand tiebreak; balancing
(break, consolidate to a final table, even out, leave-alone, six-max); config
validation and registration windows.

## Result

Engine: **41 suites / 366 tests**. API unit 52, API e2e 36, mobile 56 —
unchanged (no cash-game or wire code touched).
