# ADR-0016: Big O — wiring the hi/lo variant through the stack

Status: Accepted — 2026-09-05 (Phase 2, follow-up to ADR-0015)

## Context

ADR-0015 added `GameVariant.Omaha5HiLo` and split-pot settlement to the engine.
This makes a table actually _be_ Big O: through the database, the runner, the
lobby, and the mobile client - including showing the low winner in the feed.
It follows the same shape as ADR-0014 (PLO integration).

## Decisions

### `PokerGameType.OMAHA5_HILO` and the seat cap

`PokerGameType` gains `OMAHA5_HILO` (migration `..._poker_game_type_big_o`).
`variantForGameType` gets the case. Five hole cards only fit an eight-handed
deck, so `TablesService.create` now rejects `maxSeats > maxSeatsForVariant(...)`
(8 for Big O, 9 for everything else) with a `BadRequestException` - a belt to the
engine's own `validateTableConfig` guard.

### Wire helpers

Rather than scatter `gameType === 'PLO'` checks, `@river/shared-types` now
carries the per-game-type facts as small maps:

- `GAME_TYPE_LABEL` - "Big O (Hi-Lo)"
- `GAME_TYPE_TAG` - the lobby-card prefix ("Big O", "PLO", "" for Hold'em)
- `GAME_HOLE_CARDS` - 2 / 4 / 5
- `POT_LIMIT_GAME_TYPES` - the set played pot-limit

`lobbyFilterSchema.gameType` accepts the new value.

### Mobile

- `TableScreen` derives `holeCardCount` and `potLimit` from those maps and
  passes them down; the PLO-specific literals it had are gone.
- `SeatPod`'s card overlap tightens for five cards (`tuckStyle`) so a Big O hand
  still fits a narrow pod.
- `layout.describeEvent` labels a split pot ("High pot to ..." / "Low pot to
  ...") and appends the low to a revealed hand ("... (low: 7-5-3-2-A low)") -
  the engine already sends `POT_AWARDED.portion` and `HAND_REVEALED.low`.
- Game Details and the lobby card pick up the new labels for free.

### Seed

One Big O table: `Silver Big O` (10/20), 6-max.

## Tests

- `tables/game-variant.spec.ts` — the `OMAHA5_HILO → Omaha5HiLo` case.
- `poker-gateway.e2e-spec.ts` — a full Big O hand over two sockets (five hole
  cards each), plus `create({ gameType: 'OMAHA5_HILO', maxSeats: 9 })` is
  rejected.
- `SeatPod.test.tsx` — five face-down cards for a Big O opponent.
- `layout.test.ts` — the "High pot" / "Low pot" labels and the revealed-low line.
- `GameDetailsSheet.test.tsx` / `LobbyTableCard.test.tsx` — the Big O labels.

## Result

Engine unchanged (35 suites / 325). API unit **52**, API e2e **36**, mobile
**56**. format / lint / typecheck / build clean. A Big O table now deals five
cards, bets pot-limit, and splits the pot from the phone.

## Deploy

`fly deploy` runs the migration. `Silver Big O` appears after
`node prisma/seed.mjs`; existing rows are untouched.
