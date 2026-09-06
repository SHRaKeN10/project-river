# ADR-0023: Tournament clock and registration/lobby screens

Status: Accepted — 2026-09-05 (Phase 2, follow-up to ADR-0022)

## Context

The tournament coordinator (ADR-0019/0020), the socket bridge (ADR-0021) and
hand-for-hand play (ADR-0022) all work, but the mobile client could barely
show a tournament: the list screen was a thin status list and the table screen
had no blind clock, no field size, no bubble indicator. A player could not see
when blinds go up or how close the money is.

## Decisions

### The clock is server-authoritative but rendered locally

The server never broadcasts a per-second tick. It owns the truth as a
_bookmark_ - `startedAt`, `pausedMs`, `pausedAt` - and derives the current
level from the blind schedule (the pure `tournament-clock.ts`, unchanged). It
publishes a **snapshot** (`TournamentClockState`) only at meaningful moments:

- on `tournament:watch` (and on reconnect, which re-watches),
- on every blind-level change (`scheduleLevelAdvance`),
- after every hand-for-hand round boundary (`afterHand`, once the field / table
  count / hand-for-hand flag may have moved).

The snapshot carries `levelEndsAt` (wall-clock ms) and `serverNow`. The phone
runs a local 1-second countdown from `levelEndsAt`, correcting for device-clock
skew against `serverNow` (`useLevelCountdown` / `levelRemainingMs`), and
re-synchronises every time a fresh snapshot lands. Backgrounding is a non-issue:
the next tick recomputes from the wall clock, and the REST view (polled) carries
the same `clock` object as a fallback.

For 200 players that is a handful of events per socket over a whole tournament,
not 200 x 1/s.

### The projection: what tournament state is public

`TournamentView` gains `clock: TournamentClockState | null`, `payouts: number[]`
(the ladder - the mobile app has no engine), `registrationOpen`, `canUnregister`.
`TournamentClockState` = level, small/big/ante, `isBreak`, `levelEndsAt`,
`levelDurationMs`, `serverNow`, `handForHand`, `playersLeft`, `placesPaid`,
`tableCount`. The standalone `currentLevel` / `levelEndsAt` view fields folded
into `clock`.

Never exposed: hole cards, deck / RNG state, per-player private data,
server-only coordinator internals. The clock snapshot is built by the
coordinator (`clockSnapshot()`) or, when no runner is on this node,
reconstructed from the persisted bookmark by `TournamentsService`.

### Registration flow is unchanged - only surfaced

No new server logic. `register` / `unregister` already guard status, the
entrant cap and double-registration; `registrationOpen` / `canUnregister` just
make those rules visible so the mobile CTA is correct without a round-trip.
The lobby -> register -> assigned -> table path already worked end to end
(ADR-0021); this PR adds the screens that walk it.

### Mobile: no second state machine

- `TournamentClock` component: snapshot in, smooth countdown out. `full` and
  `compact` variants.
- `useTable` (tournament mode) gains `clock`, fed by the new `tournament:clock`
  event - the only client-side tournament state added, and it is a projection,
  not logic.
- `TournamentsScreen`: richer cards (pool, field/cap, live compact clock), tap
  through to a detail screen.
- `TournamentDetailScreen` (new): status, clock, your standing + CTA, prize
  ladder, full blind structure with the current level highlighted, final
  standings once done.
- `TournamentTableScreen`: a slim clock strip under the header (level,
  countdown, blinds, players left, hand-for-hand). The felt / seats / action
  bar are untouched.

### Real-time vs polling

The in-play experience (`TournamentTableScreen`) is socket-pushed:
`tournament:clock` on blind changes and round boundaries, plus the existing
`assignment` / `eliminated` / `tableClosed` / `finished`. The **lobby and
detail screens** refresh on the existing REST poll (5 s list / 4 s detail) -
a browsing screen does not need sub-second push, and a lobby-wide socket room
for non-watchers is a separate feature, deliberately out of scope here.

## Files changed

**shared-types**

- `tournament.dto.ts` - `TournamentClockState`; `TournamentView.clock` /
  `.payouts` / `.registrationOpen` / `.canUnregister` (drops `currentLevel` /
  `levelEndsAt`)
- `socket-events.ts` - `ServerToClient.TOURNAMENT_CLOCK`

**api**

- `tournaments/tournament-runner.ts` - `clockSnapshot()`, `playersRemaining`,
  `handForHandActive`, `{ kind: 'clock' }` public event, published on level
  advance + round boundary
- `tournaments/tournaments.service.ts` - `toView` builds `clock` (from the
  runner, or reconstructed), `payouts`, `registrationOpen`, `canUnregister`
- `realtime/tournament.gateway.ts` - forwards `clock` to a tournament's
  sockets; sends a snapshot on watch

**mobile**

- `features/tournament/clock.ts` (new) - `formatCountdown`, `levelRemainingMs`,
  `blindsLabel`, `useLevelCountdown`
- `features/tournament/TournamentClock.tsx` (new)
- `features/table/useTable.ts` - `clock` from `tournament:clock`
- `screens/TournamentsScreen.tsx` - enriched, tappable
- `screens/TournamentDetailScreen.tsx` (new)
- `screens/TournamentTableScreen.tsx` - clock strip
- `navigation/*` - `TournamentDetail` route

## Invariants preserved

- The client never decides a blind level, a finishing position, a payout or
  registration eligibility - it only renders what the server sent.
- The local countdown is display only; `levelEndsAt` and every `handForHand` /
  `playersLeft` value come from the coordinator.
- Hole-card privacy, deck / RNG opacity: the clock snapshot carries none of it.
- A player cannot register twice / unregister after the start / act once
  eliminated / act in a finished tournament - all still enforced server-side.

## Tests added

**api unit (+2, 98 total):** `clockSnapshot` tracks the schedule as fake time
advances; a `clock` event is published on start and its `playersLeft` falls to
one by the finish with `handForHand` seen at the bubble.

**api e2e (51, unchanged count):** the pre-start projection carries
`registrationOpen` / `canUnregister` / `payouts` and a null `clock`; once
RUNNING, `clock` carries level / blinds / `levelEndsAt` / `tableCount` /
`handForHand` / `playersLeft` and registration has closed. The gateway spec's
6-player run now asserts every watcher gets a clock snapshot on watch, the
field shrinks across snapshots, and hand-for-hand fires at the bubble.

**mobile (+12, 72 total):** `formatCountdown` / `levelRemainingMs` (incl. skew
correction) / `blindsLabel`; `TournamentClock` renders level + blinds + ante,
"Final level", and a break label; `useTable` adopts `tournament:clock` for the
right tournament only.

## Remaining limitations

- Lobby / detail screens are REST-polled, not socket-pushed, for other
  players' registrations and starts (up to ~5 s stale). A lobby pub/sub room
  is future work.
- No pause support in the clock yet (`clock()` still hardcodes `pausedMs: 0`) -
  antes and restart recovery are the next PRs (#4, #5).
- "Your live rank" is not shown on the table strip (only players-left); it
  would need the coordinator to project per-player standing mid-event.

## Next

Antes (#4), restart recovery (#5), deployed bot soak (#6).
