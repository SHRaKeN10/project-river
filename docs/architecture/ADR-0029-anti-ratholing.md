# ADR-0029: Anti-ratholing (cash tables)

Status: Accepted — 2026-09-06 (Phase 2 hardening, follow-up to ADR-0028)

## Context

"Ratholing" is leaving a cash game after winning a big pot and rebuying short,
so the profit can never be lost back at that table. Every serious cardroom bans
it. With real money eventually in scope, stack integrity at the table matters
more than lobby convenience, so this comes before waitlist auto-seat.

The rule, stated carefully:

> A player who **voluntarily** leaves a cash table cannot **return to that same
> table** with **less than the stack they left with** (capped at the table's max
> buy-in) for a **configurable cooldown**.

What must _not_ be caught:

| situation                                         | outcome                                   |
| ------------------------------------------------- | ----------------------------------------- |
| lost chips at the table, left, rebuys at that low | fine - the floor is their _leaving_ stack |
| left stacked (0)                                  | fine - no record is written               |
| removed by the disconnect sweep                   | fine - not a voluntary leave              |
| admin closed the table                            | fine - not a voluntary leave              |
| waited out the cooldown                           | fine                                      |
| left after winning, rebuys short within cooldown  | **blocked**                               |
| moved to a different table                        | fine - the record is per-table            |
| a tournament table                                | N/A - tournaments never touch this path   |

## Decision

### Where the state lives

`PokerTable.antiRatholeMinutes` (Int, default 30, `0` = off) - per-table,
changeable live via `PATCH /tables/:id/config`.

`model TableDeparture { tableId, userId, stack, leftAt, @@unique([tableId, userId]) }`

- one row per (table, player), holding their last voluntary departure.

### Where it's written

Seat vacates carry their reason in the cash-out `idemKey` prefix, set by
`TableRunner`: `cashout:` = voluntary leave (`onLeave` / `releasePendingLeavers`),
`away:` = disconnect sweep, `close:` = admin close.
`TableManager`'s `onSeatVacated` treats it as voluntary only when the prefix is
`cashout:` **and** the table's `antiRatholeMinutes > 0`, and passes
`recordDepartureStack` through to `TablesService.standUp`, which upserts the
`TableDeparture` row **inside the same transaction** as the seat release + chip
return (so the record and the wallet credit are atomic). A player who left
stacked (stack `0`) writes no row. A player who left mid-hand records the
_post-hand_ stack - `entry.stack` is refreshed in `onHandComplete` before
`releasePendingLeavers` runs, so winnings count.

### Where it's enforced

`TablesService.sitDown` - the one transactional buy-in + seat-claim boundary,
server-side, never the client. It reads `maxBuyIn` + `antiRatholeMinutes` fresh
from the row, looks up the departure, and if
`Date.now() - leftAt < antiRatholeMinutes * 60_000` and
`buyIn < min(departure.stack, maxBuyIn)`, throws a `BadRequestException` naming
the leaving stack, the floor, and the minutes left. On a successful seat claim
it `deleteMany`s the departure row in the same transaction - a legitimate return
resets the clock, so a later leave-with-less is measured fresh.

The gateway already `await manager.settleSeatChanges(tableId)` before `sitDown`,
which waits out the in-flight cash-out (now including the departure write), so an
immediate leave→rejoin sees an accurate record.

### Projection

`TableStateView.antiRatholeMinutes` surfaces the policy; the mobile Game Details
sheet shows "Re-buy policy: return with your leaving stack for N min". Enforcement
stays entirely server-side - the client only relays the rejection message.

## Consequences

- No engine change; no runner behaviour change. It's a DB-transaction gate plus
  one write on a voluntary stand-up.
- Losing at the table, disconnects, table close, and cross-table moves are all
  unaffected by construction.
- The floor is the leaving stack capped at the max buy-in, so a player who left
  huge is never asked for more than a legal buy-in.
