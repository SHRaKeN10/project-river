# ADR-0006: Multiplayer tables (Socket.IO gateway + table actors)

Status: Accepted — 2026-09-01 (STEP 5)

## Context

The engine plays a hand headless. STEP 5 puts real players around a table over
WebSockets, server-authoritative.

```
socket.io client ──► PokerGateway ──► TableManager ──► TableRunner (1 per table)
       ▲                                                      │
       │       per-viewer projection  ◄───── notify ──────────┘  reduce()
       │                                                      │
    table:state / hand:update              DB seat roster + Redis state snapshot
```

## Decisions

### One actor per table

`TableManager` owns a `Map<tableId, TableRunner>`. Each `TableRunner` holds the
authoritative `GameState` and a **serial command queue** — join / action /
timeout / leave are processed one at a time, so two actions for the same table
can never interleave. No locks, no races. All runners run in the API process
(single node); the manager is the seam where table sharding across nodes goes
later.

### The gateway only projects

`PokerGateway` authenticates the handshake JWT (via `TokenService`), routes
client events to the right runner, and — on every runner notification —
re-projects the state **per socket** and emits. The runner never touches
sockets.

### Per-viewer projection (`table-projection.ts`, `event-projection.ts`)

Pure functions. A viewer gets their own hole cards, `null` for everyone else
(until a seat is in `revealedSeats` at showdown), and `legalActions` only when
it's their turn. The **deck, its cursor, and hidden hole cards never leave the
server** — an e2e test asserts no `"deck"`/`"cursor"` ever appears in a client
message. Burn cards are stripped from street events. `ACTION_REJECTED` is never
broadcast — the actor gets an `error` directly.

### Timers

The runner arms an action timer when `actingSeat` is set (`actionDeadline`
epoch-ms is on the projected state for the client countdown). On expiry it
enqueues `TIMEOUT` → the engine auto-checks or auto-folds. Hands auto-start
`TABLE_START_DELAY_MS` after two funded players are seated, and the next hand
`TABLE_NEXT_HAND_DELAY_MS` after one completes. Timers are injected, so the
runner is fully unit-testable with a fake clock.

### Chips

`User.playChips` — free-to-play game currency, **not money**. Buy-in debits it,
leaving/cashing-out credits it back, `/api/chips/rebuy` tops a broke player
back to the grant. "Never trust client chip balances" — the buy-in amount is
validated against the table range and the balance is debited atomically
(`updateMany … where playChips >= amount`).

### Persistence & recovery

- `PokerTable` + `PokerTableSeat` rows: durable table config + the seat/stack
  roster, written back after every hand.
- Redis `table:<id>:snapshot` = full serialized `GameState` + roster, written
  after every command (2h TTL). On runner creation the snapshot is restored if
  present (an in-progress hand survives an API restart); otherwise the roster is
  rebuilt from the DB and players reconnect into their seats.

### De-dup & reconnect

Each action carries a monotonic `clientSeq`; a seq `≤` the last accepted one for
that user is ignored (double-tap / reconnect resend). On reconnect the client
re-emits `table:join` and gets a fresh `table:state`.

### Scaling seam (not built)

`@socket.io/redis-adapter` is wired so room broadcasts already work across
nodes. True multi-node needs the `TableManager` to place each runner on exactly
one node (Redis lock / coordinator) — the interface doesn't change.

## Tests

- `table-projection.spec.ts` — own vs others' cards, showdown reveal, no deck,
  legalActions gating, spectator view.
- `table-runner.spec.ts` — auto-start, fold-out + chip conservation, wrong-player
  reject, `clientSeq` de-dup, action-timeout auto-play, leave-between-hands.
- `poker-gateway.e2e-spec.ts` — **two real socket.io clients register, join, and
  play a full hand end to end**; asserts each sees only their own cards, the
  deck never leaks, `PokerTableSeat.stack` totals are conserved, and each
  `User.playChips` was debited by the buy-in.
