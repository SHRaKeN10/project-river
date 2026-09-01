# ADR-0011: Mobile lobby (STEP 7b)

Status: Accepted — 2026-09-01 (STEP 7b)

## Context

7a shipped the app shell with a placeholder Lobby screen. 7b makes it real:
the live cash-game list, filters, favourites, waitlist, and socket-driven
updates — reusing the lobby REST + WS surface built in STEP 6 (ADR-0007).

## Decisions

### Client-side filtering over a single cached list

`useLobbyTables()` fetches `GET /api/lobby` **unfiltered** (one query key,
`['lobby']`) and the screen filters the ~handful of rows in a `useMemo`. This
keeps the live-delta path trivial — `lobby:update` patches one entry in one
cached array — and makes filter changes instant. The server-side
`lobbyFilterSchema` query params are still there for when the list grows.

Stake buckets (Micro ≤2 / Low ≤10 / Mid ≤50 / High) are a single-select chip
row; "Open seats" and "Favourites" are independent toggles.

### Live updates: `useLobbyLive` bound to screen focus

`useFocusEffect` joins the `lobby` room on focus and leaves on blur. Handlers:
`lobby:tables` replaces the cache, `lobby:update` patches a row, and
`waitlist:seatAvailable` raises an `Alert` with a "Take seat" action that
navigates to the table. Re-subscribes on socket `connect` (reconnect).

### Optimistic favourite / waitlist mutations

`useToggleFavorite` and `useWaitlist` patch the `['lobby']` cache in
`onMutate`, roll back in `onError`, and `invalidateQueries` in `onSettled`.
Waitlist also adjusts `waitlistCount` locally so the card badge moves
immediately.

### Tapping a table opens it

`navigation.navigate('Table', { tableId })` — the buy-in / seat-selection flow
lives on the table screen (STEP 7c). Full tables show a "Join waitlist" /
"Leave waitlist" button on the card instead of opening.

### New shared UI primitives

`Card`, `Tag` (5 tones), `FilterChip`, `EmptyState` — small, token-driven,
added to `components/index.ts`.

### Seed data: the free-play cash ladder

`apps/api/prisma/seed.ts` (wired as `prisma db seed`, `pnpm --filter @river/api
prisma:seed`) creates six standard tables (Rookie 1/2 … Diamond 50/100),
idempotently by name. Not run in CI — the e2e suite creates its own tables;
two lobby e2e stake-filter assertions were tightened to ignore rows they
didn't create, so a seeded dev DB no longer breaks them.

## Verification

typecheck + lint + `expo export` (873 modules, was 865). API 33 unit + 19 e2e
still green against a seeded dev DB. No device/simulator here, so no
runtime/interaction testing yet — 7c will need one.
