# ADR-0014: Pot-Limit Omaha — wiring the engine variant through the stack

Status: Accepted — 2026-09-05 (Phase 2, follow-up to ADR-0013)

## Context

ADR-0013 added `GameVariant` (HOLDEM | OMAHA) and four-card PLO to the engine,
but every table was still built as Hold'em. This change lets a table actually
_be_ PLO: through the database, the runner, the lobby, and the mobile client.

## Decisions

### `PokerGameType.PLO` and the `gameType → variant` map

`PokerGameType` gains `PLO` (migration `..._poker_game_type_plo`). The two enums
meet in one place: `apps/api/src/tables/game-variant.ts` -
`variantForGameType(gameType)` returns `GameVariant.Omaha` for `"PLO"`, else
`GameVariant.Holdem` (unknown values fall back to Hold'em, never throw).

`TableManager.build()` and `HandsService.replayForViewer()` both pass
`variant: variantForGameType(table.gameType)` into `createTableConfig`. The
runner's snapshot backfill from ADR-0013 (`{ ...engineConfig, ...snapshot.config }`)
now supplies the right variant for a PLO table recovered mid-hand.

`TablesService.create` takes an optional `gameType` (defaults `NLHE`); the admin
create endpoint validates `z.enum(['NLHE', 'PLO'])`.

### Wire contract

`GameType` enum gains `PLO`, plus `GAME_TYPE_LABEL` ("No-Limit Hold'em" /
"Pot-Limit Omaha") for headers. `lobbyFilterSchema.gameType` accepts `PLO`.
`TableStateView.gameType` and `LobbyTableView.gameType` already carried the
string - no shape change.

### Mobile

- **Seat pods** take a `holeCardCount` (2 by default, `4` when
  `view.gameType === 'PLO'`). Four cards overlap (`cardTuck`, `marginLeft: -12`)
  so the row still fits a narrow pod. `PublicSeatView.holeCards` was already an
  array, so a PLO hero's four face-up cards needed no server change.
- **Action bar** takes `potLimit`. When set, the sizing presets are
  `Min / ½ / ¾ / Pot`, and "Pot" is `range.max` exactly (the server's pot-limit
  ceiling from `legalActions`), with no separate "Max" chip - under pot limit
  the two are the same number. No-limit tables are unchanged.
- **Game Details** spells out the variant; the **lobby card** prefixes `PLO · `
  to the stakes line for a PLO table (Hold'em rows unchanged).

### Seed

Two PLO tables: `Bronze PLO` (5/10) and `Silver PLO` (10/20), both 6-max, same
time-charge rate card as the Hold'em ladder.

## Tests

- `tables/game-variant.spec.ts` — the enum map, including the unknown fallback.
- `poker-gateway.e2e-spec.ts` — a full PLO hand over two real sockets: the hero
  always holds exactly four cards, and every `RAISE`/`BET` bound the server
  offered equalled `currentBet + pot + owed` (the pot-limit cap).
- `SeatPod.test.tsx` — four face-up cards for an Omaha hero; `holeCardCount`
  face-down cards for an opponent.
- `ActionBar.test.tsx` — pot-limit presets: "Pot" is the exact ceiling, no "Max".
- `GameDetailsSheet.test.tsx` / `LobbyTableCard.test.tsx` — the PLO labels.

## Result

Engine unchanged (31 suites / 302). API unit **51**, API e2e **35**, mobile
**51**. A PLO table now deals, bets, and settles end to end from the phone.

## Deploy

`fly deploy` runs the migration (release command). The new `Bronze PLO` /
`Silver PLO` tables appear after `node prisma/seed.mjs`; existing rows are
untouched (explicitly re-stamped `NLHE`, a no-op).
