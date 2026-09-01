# ADR-0008: Mobile app shell (auth, navigation, clients)

Status: Accepted — 2026-09-01 (STEP 7a)

## Context

`apps/mobile` was a one-screen Expo skeleton. 7a builds the real shell:
auth, navigation, the API client, the socket client, and the design system —
so 7b (lobby) and 7c (table) just add screens.

## Decisions

### `node-linker=hoisted`

Metro's resolver can't follow pnpm's symlinked `.pnpm` store to find
transitive runtime deps (`@babel/runtime`). Set `node-linker=hoisted` in the
root `.npmrc` — Expo's documented setting for pnpm monorepos. The API, engine,
and shared-types are unaffected (they declare their deps honestly); all tests,
e2e, and builds re-verified. `expo export` now bundles the app clean (865
modules).

### Styling: plain StyleSheet + a tokens module (not NativeWind yet)

`src/theme/tokens.ts` holds the palette / spacing / radius / typography. Dark,
minimal, gold chip accent. NativeWind can be layered on later without touching
the tokens; deferred because it can't be exercised without a running device
here.

### Auth (`features/auth/`)

- `tokenStorage` — `expo-secure-store` for the access + refresh tokens.
- `authStore` (Zustand) — `status: loading | authed | guest`, user, tokens.
  `hydrate()` on boot: load tokens → `GET /auth/me` to validate → authed, else
  guest. `login`/`register` persist the session; `logout` best-effort calls the
  API then clears.
- The store wires `configureApi({ getAccessToken, refresh, onAuthLost })` once,
  so the API client can transparently refresh on a 401 (single-flight guard)
  and force-logout if refresh fails.

### API client (`features/api/`)

`apiFetch<T>(path, { method, body, auth, query })` — base URL from
`EXPO_PUBLIC_API_URL` / expo config, bearer header, 401 → refresh → retry once,
typed `ApiError`. Typed endpoint wrappers (`authApi`, `chipsApi`). TanStack
Query for server-state (`useChips`, `useRebuy`).

### Socket (`features/realtime/socket.ts`)

One shared `socket.io-client` connection for the whole app (lobby + table live
on the same server). Connected on `authed`, disconnected on `guest`, token
refreshed in place. Reconnection on by default.

### Navigation

React Navigation native-stack. `RootNavigator` shows `SplashScreen` while
loading, then `AuthNavigator` (Login, Register) or `AppNavigator`
(Home, Lobby, Table, Profile, Settings) by auth status. Register/Login validate
with the exact `@river/shared-types` zod schemas the API uses.

## Screens in 7a

Splash, Login, Register, Home (chip balance + nav), Profile (info + top-up),
Settings (version + sign out). Lobby and Table are placeholders for 7b / 7c.

## Verification

typecheck + lint + `expo export` (full Metro bundle). No device/simulator
available here, so no runtime/interaction testing yet.
