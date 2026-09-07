# ADR-0031: Waitlist auto-seat

Status: Accepted — 2026-09-07 (Phase 3 — cardroom ops, last feature before the alpha freeze)

## Context

The waitlist so far was **notify-only**: when a seat freed, the head of the
queue got a `waitlist:seatAvailable` ping and had to race everyone else to
`table:join`. Two players could grab the same seat; a slow head lost it to a
walk-up; there was nothing holding the seat.

The rule this ADR implements:

> When a seat frees, the head of the table's waitlist is given a **short-lived
> hold on one specific seat**. While the hold is live, only they can take that
> seat. They claim it with a normal `table:join`. If they don't claim it in
> time they **lose their place** and the seat passes to the next in line. A
> walk-up may still take any _other_ open seat.

### The invariant

**A physical seat can never be claimed by two players** — regardless of
simultaneous vacate/claim events, reconnects, duplicate socket messages, or
multiple eligible waitlisters. Claiming is **idempotent**: a duplicate claim
produces the same final state (seated once, debited once), never a second seat.

## Decision

Consistent with River's model — server-authoritative, the DB is the seat
authority, no distributed table-ownership. No new actor, no engine change.

### `TableSeatReservation`

```prisma
model TableSeatReservation {
  tableId, userId, seatNumber, expiresAt, createdAt
  @@unique([tableId, seatNumber])   // one hold per physical seat
  @@unique([tableId, userId])       // one hold per user per table
  @@index([expiresAt])
}
```

The `@@unique([tableId, seatNumber])` is **the concurrency guard**: two
`promote` calls racing for the same freed seat both try to `create` the row;
exactly one wins, the other catches `P2002` and bails.

### `WaitlistService`

- **`promote(tableId)`** — called on `seatVacated`. Clears expired holds, finds
  the first open, unheld seat, walks the waitlist **in order**, and gives the
  first eligible head a hold (`create` + `waitlist:seatAvailable`). Eligible =
  online, not already seated here, wallet ≥ the table's min buy-in. **One seat
  is handed out at a time, strictly FIFO** — while the head holds a seat,
  `promote` is a no-op even if more seats are open.
- **`sweep()`** — a periodic timer (`WAITLIST_SWEEP_MS`, default 5 s, also run
  once on boot). Expires stale holds — **and the waitlist entry that went with
  them**, so a player who lets their window lapse loses their place — then
  re-promotes. Because state lives entirely in the DB and there are **no
  in-memory timers**, a process restart is handled for free: the boot sweep
  clears anything that expired during downtime and re-promotes; a still-valid
  hold survives and stays claimable.
- **`claimInfo` / REST `POST /api/lobby/:id/waitlist/claim`** — returns
  `{ seatNumber, expiresAt }` for the current hold (for a non-socket client);
  the seating itself is still `table:join`.
- **`leave` / `release`** — leaving the waitlist (or explicitly releasing) drops
  any held seat and re-promotes.

### `sitDown` enforces the hold

`sitDown` (the one seat-claim transaction, ADR-0006) now, inside its
transaction:

1. rejects a join to a seat held for **someone else** and unexpired →
   `SEAT_RESERVED` (409). A walk-up to a different open seat is unaffected.
2. on a successful claim, deletes this user's hold **and** their waitlist entry
   for the table — atomic with the seat write and the buy-in debit.

The pre-existing atomic `updateMany where userId: null` is the ultimate backstop
— even if reservations were somehow bypassed, two joins for one seat can never
both win the row (the loser gets `SEAT_TAKEN`).

### Presence

The lobby gateway (which owns the socket server) hands the service an
`isOnline(userId)` / `notify(userId, …)` pair via `bind()`. Offline heads are
skipped so an online player behind them isn't made to wait out the window.

## Consequences

- New `TableSeatReservation` table + migration
  (`20260907000000_waitlist_seat_reservation`). Additive.
- New error code `SEAT_RESERVED` (and `WAITLIST_NO_RESERVATION`).
- `waitlist:seatAvailable` payload gains `seatNumber` + `expiresAt` (was
  `{ tableId }` only). Mobile shows "your seat is ready" and opens the buy-in
  sheet straight onto the held seat.
- New env: `WAITLIST_CLAIM_WINDOW_MS` (default 25 s), `WAITLIST_SWEEP_MS`
  (default 5 s).
- **Known follow-ups:** a walk-up is _not_ blocked from an open seat just
  because a waitlist exists (only from a specifically-held seat) — full "the
  list has priority" is a bigger behaviour change, deferred. There is no
  per-seat "next charge" or cross-node presence (single machine only, as
  everywhere else).
