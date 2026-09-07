# ADR-0032: Hold a tournament watch that arrives before the start

Status: Accepted — 2026-09-07 (fixes soak #6 P2; last change before the alpha freeze)

## Context

Soak test #6 found: a client that sends `tournament:watch` while the tournament
is still in registration gets `{ error: 'that tournament is not running' }` and
its socket is **not tracked**. When the tournament then starts, the coordinator
publishes `assigned` events for every seated player — but this socket is not in
the gateway's `tracked` map, so it is never attached, and the table screen stays
blank until the client re-navigates.

The normal production flow doesn't hit this (register → wait on the detail
screen, which polls status over REST → tap "Enter" once `RUNNING`). But a client
that lands on the table screen early — a deep link, a fast tapper, a reconnect
during the countdown — is stuck.

## Decision

**Server-side: hold the watch.** In `TournamentGateway.onWatch`, when there is
no runner but the tournament row exists and is `SCHEDULED` / `REGISTERING`,
track the socket with a sentinel table id (`AWAITING_START`) and ack `{ ok:
true }` instead of erroring. Nothing is emitted yet — there is no state.

When the coordinator starts:

- It publishes an `assigned` event per seated entrant (unchanged). The existing
  `onAssigned` loop already iterates `tracked` and, finding the held socket
  (`tableId === AWAITING_START !== realTableId`), moves it into the real room
  and sends the assignment + state. **Registered players are covered by code
  that already exists** — they just need to be in `tracked`.
- `onAssigned` now also calls **`flushAwaitingStart(tournamentId)`**, which
  routes any socket still in `AWAITING_START` for that tournament to the
  spectator table (a pre-start watcher who never registered gets no `assigned`
  of their own) and sends it a state + clock snapshot.

`statusOf(tournamentId)` is a new one-line read on `TournamentManager` (row
status without a runner).

No client change. The mobile `useTable` tournament hook already renders
`table:state` / `tournament:assignment` / `tournament:clock` and, since the ack
is now `{ ok: true }`, no longer shows a `WATCH_FAILED` error — it sits on
"Finding your table…" until the first state arrives.

## Consequences

- A held pre-start watch counts as a tracked socket. `handleDisconnect` /
  `onUnwatch` already tolerate a missing runner (`this.tournaments.get(...)?.`),
  so a client that leaves before the start is cleaned up normally.
- Chose server-side over "client re-issues `tournament:watch` on
  `REGISTERING → RUNNING`" because it is one place and works for every client,
  and the client has no reliable signal for that transition on the table screen
  (the clock only starts arriving _after_ a successful watch).
- Not changed: the "Finding your table…" copy while awaiting start (cosmetic;
  the alpha-freeze rule says wait for humans to tell us it matters).
