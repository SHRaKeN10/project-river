# ADR-0012: Mobile poker table (STEP 7c)

Status: Accepted — 2026-09-02 (STEP 7c)

## Context

7b made the lobby real. 7c is the table itself: spectate, take a seat, and play
a hand live over the Socket.IO gateway from STEP 5.

## Decisions

### Spectator mode added to the gateway

`table:join` requires a seat and a buy-in, so there was no way to look at a
table first. Added `ClientToServer.TABLE_WATCH` / `TABLE_UNWATCH`: `onWatch`
just joins the room and sends the current `table:state`; `onUnwatch` leaves
(unless the caller is actually seated). e2e covers it — a spectator sees the
table, no seat, no cards, no `legalActions`, and is not charged.

### The client renders from `table:state` snapshots, not the event stream

The server already sends a full authoritative `TableStateView` after every
command. `useTable` holds the latest snapshot and renders straight from it —
seats, cards, pot, `actingSeat`, `actionDeadline`, `legalActions`. `hand:update`
events are used only for a one-line feed ("Alice raises to 120"); nothing on
screen depends on replaying them. This keeps the client trivially consistent
with the server and immune to a dropped/duplicated event.

### Empty seats are now in the projection

`projectTableState` skipped empty seats, so a fresh table sent `seats: []` and
the client had nothing to tap. It now emits a placeholder `PublicSeatView`
(`status: 'EMPTY'`, `userId: null`) for every unoccupied seat index.

### Action bar from `legalActions`

Fold / Check-or-Call / Bet-or-Raise. Raise opens a sizing panel with Min / ½ /
¾ / Pot / Max presets and a big-blind stepper (no slider — cleaner on touch,
and `@react-native-community/slider` doesn't work on web). All amounts are
"raise-to" totals, clamped to `[min, max]`; the server re-validates and a
rejection surfaces as a dismissible error bar.

### `useTable` hook

`table:watch` on mount / `table:unwatch` on unmount; adopts `table:state` for
the matching tableId; monotonic `clientSeq` for `player:action`; guards against
acting with no `handId`; feed lines from `hand:update`; re-subscribes on socket
`connect`.

### tokenStorage web fallback

`expo-secure-store` is native-only. `tokenStorage` now uses `localStorage` on
`Platform.OS === 'web'` and swallows load errors, so the auth flow works in the
Expo web preview (used for the runtime smoke test below). Web is not a shipping
target.

### Metro: force a single React

pnpm's nested store gave Expo web two copies of React ("invalid hook call").
`metro.config.js` now redirects every `react` / `react/jsx-runtime` /
`react-dom` request to the hoisted copy via `resolver.resolveRequest`.

### Jest for mobile

`jest-expo/ios` preset + `@testing-library/react-native`. pnpm needed a custom
`transformIgnorePatterns` (matches `.pnpm/<pkg>@<ver>/node_modules/`) and
`moduleNameMapper` pinning `react` / `react-native` / `react-test-renderer` to
the hoisted copies. `--forceExit` for jest-expo's known teardown warning.

## Verification

- **24 mobile unit tests**: `layout` (seat ring, turn logic, event feed),
  `ActionBar` (renders from options; raise sizing + clamp; emits actions),
  `SeatPod` (empty / occupied / hero cards / folded), `useTable`
  (watch/unwatch, snapshot adoption, feed, error handling, monotonic seq).
- **API**: 33 unit + 20 e2e (spectate test added).
- **Runtime smoke test** (Expo **web** — no iOS/Android simulator on this
  machine): registered a user, browsed the seeded lobby, opened a table as a
  spectator, watched a second player (bot) join live, sat down through the
  buy-in sheet, and **played two full hands to showdown** — hole cards, board
  deal, turn timer, check/call/bet, pot, payout, next-hand button rotation, and
  the lobby's `seatedCount` / `avgPot` / `handsPlayed` all updated live.
- typecheck + lint + `expo export` (native bundle, 883 modules) green.

### Known cosmetic gaps (not blocking)

Seat-pod placement around the oval is approximate on the narrowest phones; the
RN `Modal` used by the buy-in sheet renders slightly off on web (fine on
native); no card-deal/chip animations yet. All are pure-presentation polish for
a later pass.
