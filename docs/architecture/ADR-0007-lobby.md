# ADR-0007: Poker lobby

Status: Accepted — 2026-09-01 (STEP 6)

## Context

Players need to browse tables, filter them, favourite them, and queue for a
seat when a table is full — and see it all update live.

## Decisions

### Live data comes from two sources

- **DB** (`PokerTable`, `PokerTableSeat`, `TableWaitlistEntry`) — durable config,
  the seat roster written back after each hand, and the waitlist.
- **`TableManager`** — the in-memory `TableRunner` is asked for the _current_
  seat count and whether a hand is running (fresher than the DB, which only
  syncs between hands). `LobbyService.toView` prefers the runner when one
  exists, falls back to the DB row otherwise.

### Average pot

`PokerTable.handsPlayed` + `potSum` are incremented by the runner via a
`recordHandStats` dep on every `HAND_COMPLETED`. `avgPot = round(potSum /
handsPlayed)`. `Int` columns — fine for free-play; a very long-lived table would
need `BigInt`, noted.

### REST

`GET /api/lobby` (filters: `gameType`, `minBigBlind`/`maxBigBlind`,
`hasOpenSeat`, `favoritesOnly`, `includePrivate`), `GET /api/lobby/:id`,
`POST|DELETE /api/lobby/:id/favorite`, `POST|DELETE /api/lobby/:id/waitlist`
(POST returns `{ position }`). Query-string booleans only accept the literal
`"true"`/`"1"` — `z.coerce.boolean()` would treat `"false"` as truthy.

### Live updates — `LobbyGateway`

A second `@WebSocketGateway` sharing the same socket.io server (and JWT
handshake auth). `lobby:subscribe` joins the `lobby` room and returns the full
list; the gateway subscribes to `TableManager` notifications and broadcasts a
compact **public** `LobbyTableDelta` (`seatedCount`, `openSeats`,
`waitlistCount`, `handInProgress`, `avgPot`, `status`) as `lobby:update`.
Per-user flags (`isFavorite`, `onWaitlist`) stay client-side and are merged
into the cached row.

### Waitlist promotion

On a `seatVacated` notification the gateway pings the **head** of that table's
waitlist with `waitlist:seatAvailable { tableId }` — they still join normally
(`table:join`), and the poker gateway removes them from the waitlist on a
successful seat. No auto-seating (avoids buying a player in without consent).

## Tests

`lobby.e2e-spec.ts` (5): list + display fields, stake/privacy filters,
favourite round-trip + `favoritesOnly`, waitlist position + count, and a
**`lobby:update` push** when two sockets sit down at a table.
