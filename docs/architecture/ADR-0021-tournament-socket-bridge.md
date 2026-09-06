# ADR-0021: The tournament socket bridge

Status: Accepted — 2026-09-05 (Phase 2, follow-up to ADR-0020)

## Context

ADRs 0017-0020 built the tournament engine and coordinator and proved them at
scale (200 players / 23 tables), but headless - only tests could play. This PR
connects the coordinator to the existing Socket.IO layer so a real mobile
player can watch, register, take their seat, see their own cards, act, get pot
awards, be moved between tables, be eliminated, and reconnect.

It is deliberately the **smallest bridge**: no bubble / chop logic, no clock
UI, no antes, no restart recovery. Those are separate tasks.

## Decisions

### A second gateway, everything else reused

`TournamentGateway` is a second `@WebSocketGateway` on the same socket.io
server (like `LobbyGateway`). It reuses:

- the JWT handshake middleware `PokerGateway` installs;
- the **same wire events** the mobile table UI already listens for -
  `table:state`, `hand:update` / `hand:start` / `hand:end`, `error`;
- the **same per-viewer projection code** - `projectTableState` and
  `projectEvent` - so hole cards, the deck, and the seed never leak, and a
  spectator gets `youAreSeat: null` / `legalActions: null` / no cards;
- a new shared `toEngineAction` helper, extracted from `PokerGateway`, so the
  wire→engine action mapping lives in exactly one place. **No poker action
  logic is duplicated** - it stays in the engine, driven by the already-tested
  `TournamentTableRunner`.

New, tournament-specific events: `tournament:watch` / `tournament:unwatch` /
`tournament:action` (client→server) and `tournament:assignment` /
`tournament:eliminated` / `tournament:tableClosed` / `tournament:finished`
(server→client).

### The client says "tournament X", the server routes

There is no join / leave / buy-in - the coordinator owns the seats. A client
emits `tournament:watch { tournamentId }`; the server looks up
`runner.tableIdOf(userId)` and joins the socket to that table's room
(`t:<tournamentId>:<tableId>`), or - for a seatless viewer - to the feature
table as a spectator. On a balance move the coordinator emits `assigned`; the
gateway leaves the old room, joins the new one, and pushes a fresh state.
`table:state` for a tournament carries a `tournamentId`, and the mobile hook
filters on that (the `tableId` changes when you're moved).

### Coordinator → gateway events

`TournamentRunner` gained an optional `publish(ev)` dep and
`TournamentManager` a `subscribe(listener)`. The coordinator emits
`tableUpdate` (the raw `TournamentTableNotification` for state / events /
rejected), `assigned`, `eliminated`, `tableClosed`, and `finished`. Read-model
accessors (`tableIdOf`, `spectatorTableId`, `getTable`, `entrantView`) let the
gateway project without duplicating coordinator state. `TournamentTableRunner`
now also tracks `revealedSeats` and exposes a `roster()` / `tableMeta()` in the
exact shape `projectTableState` wants.

### Server-authoritative, always

An action goes to `runner.act(userId, ...)` which routes to the player's own
table; `TournamentTableRunner.onAction` rejects it (`NOT_SEATED` /
`STALE_HAND`) if the caller holds no seat there or the hand has moved on. A
pure spectator is stopped one layer earlier (`tableIdOf` is null → ack error).
Duplicate `clientSeq` is swallowed by the table's per-hand high-water mark.
Determinism / replay is unchanged - the engine and the table runner are
untouched on that path.

### Mobile

`useTable(id, { tournament: true })` - `id` is the tournamentId; watch / act go
through the tournament events, state filters on `tournamentId`, and it surfaces
`eliminated` / `finished`. A `TournamentTableScreen` composes the existing
`CommunityBoard` / `SeatPod` / `ActionBar` + layout helpers (no buy-in / rebuy
/ leave). A `TournamentsScreen` lists tournaments and registers / enters via
the existing REST endpoints.

## Known limitations

- No bubble / chop, no clock UI, no antes, no restart recovery (separate).
- Cross-table simultaneous busts are still ordered by processing order
  (hand-for-hand bubble freeze is a follow-up).
- A reconnecting client mid-hand can have an action swallowed if its
  `clientSeq` restarts below the pre-disconnect high-water for that same hand
  (same as the cash game; almost always a new hand by reconnect time).
- Single node only, by design - the coordinator, every table, and every socket
  live in the one API process.

## Tests

- `tournament-gateway.e2e-spec.ts` (5, real sockets):
  - a spectator gets a read-only view and its action is refused;
  - a seated player sees only its own hole cards pre-showdown, no deck, and
    receives turn prompts with legal actions;
  - a duplicate `clientSeq` is swallowed and a stale `handId` is rejected;
  - a 6-player / two-table tournament: initial routing onto two tables,
    `assignment` for everyone, at least one balance/break reassignment, a
    `tableClosed`, five `eliminated` events at positions 6..2, pot awards
    delivered, and a `finished` event to every client with the full standings;
  - a player disconnects and reconnects mid-tournament - same seat, same
    table, chip total conserved, no errors.
- `useTable.test.ts` (+4): tournament mode watches / acts by tournamentId,
  filters state on it, surfaces assignment / elimination / finish, and refuses
  a buy-in.

## Result

API unit **74**, API e2e **51** (+5). Engine 366. Mobile **60** (+4). `expo
export` iOS bundle clean. format / lint / typecheck / build green.

## Next

Hand-for-hand bubble + chops; then the tournament clock / registration screens;
then a longer bot soak on the deployed app.
