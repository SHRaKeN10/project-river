# Project River

Mobile-first, **server-authoritative** multiplayer poker platform. The MVP is
**free-to-play No-Limit Texas Hold'em** — no real money, deposits, withdrawals,
wagering, or rake. The architecture keeps the poker engine isolated so approved
game types and (post-legal-review) wallet systems can be added later without
rewriting it.

Everything here is original. Do not copy code, branding, art, or exact UI
layouts from any existing poker platform.

## Monorepo layout

| Path                    | Package               | Description                                                               |
| ----------------------- | --------------------- | ------------------------------------------------------------------------- |
| `apps/api`              | `@river/api`          | NestJS modular monolith — REST + WebSocket gateway, table manager         |
| `apps/mobile`           | `@river/mobile`       | React Native (Expo) app — iOS + Android                                   |
| `packages/poker-engine` | `@river/poker-engine` | Pure, deterministic Hold'em rules engine — complete for NLHE (`reduce()`) |
| `packages/shared-types` | `@river/shared-types` | Wire contracts & enums shared across all apps                             |
| `packages/config`       | `@river/config`       | Shared tsconfig / eslint / jest presets                                   |

Admin dashboard (`apps/admin`, Next.js) lands in Phase 9.

## Prerequisites

- **Node 22 LTS** (`.nvmrc`). Node 20.11+ also works.
- **pnpm 9** — `corepack enable && corepack prepare pnpm@9.12.3 --activate`
- **Docker** + Docker Compose (Postgres + Redis for local dev)

## First-time setup

```bash
# 1. install workspace dependencies
pnpm install

# 2. start local infrastructure (Postgres, Redis, Adminer on :8080)
cp .env.example .env
pnpm infra:up

# 3. configure the API
cp apps/api/.env.example apps/api/.env.development.local

# 4. generate the Prisma client and run the first migration
pnpm --filter @river/api prisma:generate
pnpm --filter @river/api prisma:migrate --name init

# 5. build shared packages once
pnpm --filter @river/shared-types --filter @river/poker-engine build
```

## Running

```bash
# API  -> http://localhost:3000  (health: /health/live, /health/ready)
pnpm --filter @river/api dev

# Mobile (Expo) -> press i / a / w
pnpm --filter @river/mobile dev
```

## Verify everything

```bash
pnpm typecheck      # all packages
pnpm lint
pnpm test           # poker-engine unit + property tests, API unit tests
pnpm --filter @river/api test:e2e   # needs infra up + prisma generate
pnpm build
```

## Auth API (Phase 2)

All under `/api/auth`. See `docs/architecture/ADR-0002-authentication.md`.

```bash
# register (returns { user, tokens }); auto-logs-in
curl -sX POST localhost:3000/api/auth/register -H 'content-type: application/json' \
  -d '{"email":"you@example.com","username":"you","password":"a-good-passphrase"}'

# login
curl -sX POST localhost:3000/api/auth/login -H 'content-type: application/json' \
  -d '{"emailOrUsername":"you","password":"a-good-passphrase"}'

# authenticated request
curl -s localhost:3000/api/auth/me -H "authorization: Bearer <accessToken>"

# rotate the refresh token
curl -sX POST localhost:3000/api/auth/refresh -H 'content-type: application/json' \
  -d '{"refreshToken":"<refreshToken>"}'
```

`refresh` rotates the token every call; replaying an old one revokes the whole
session. In non-production, `password-reset/request` and
`email-verification/request` return the raw token as `devToken` (no email
service yet).

## Poker engine (`@river/poker-engine`)

Pure TypeScript, zero runtime deps. **Complete for No-Limit Hold'em.** The one
entry point is `reduce(state, action, rng) → { state, events[] }` — pure and
total (illegal actions yield an `ACTION_REJECTED` event, never a throw); all
randomness via the auditable `RandomProvider`.

```ts
import { initGameState, reduce, CryptoRandomProvider } from '@river/poker-engine';

let state = initGameState({ tableId, config, players });
const rng = new CryptoRandomProvider();
({ state } = reduce(
  state,
  { type: 'START_HAND', handId, handNumber: 1, previousButtonSeat: null },
  rng,
));
({ state } = reduce(
  state,
  { type: 'PLAYER_ACTION', seat: 3, action: { type: 'RAISE', amount: 60 } },
  rng,
));
// … the last action of an all-in hand emits FLOP/TURN/RIVER + showdown + payouts in one result
```

Modules: `cards` · `deck` · `shuffle` · `hand-evaluator` · `player` · `table` ·
`betting` · `action-validator` · `game-state` · `pot-manager` (side pots +
dead-money refunds) · `street-manager` · `showdown` · `events` · `reducer`.

**224 tests** including a `pokersolver` oracle cross-check, a 100k-hand
evaluator distribution simulation, and a **~14,000 random full-hand simulation
that asserts chip conservation after every action**. See ADR-0003 / 0004 / 0005.

```ts
import { evaluate, compareHandRanks, parseCards, describeHand } from '@river/poker-engine';

const alice = evaluate(parseCards('As Ah Kd Kc 2d 7h 9s')); // two pair, Aces & Kings
const bob = evaluate(parseCards('Qs Qh Qd Kc 2d 7h 9s')); // trips
compareHandRanks(alice, bob); // < 0  -> bob wins
describeHand(bob); // "Three of a Kind, Queens"
```

## Conventions

- Server is the only authority for cards, shuffles, legal actions, winners, pots.
- The poker engine never imports NestJS, Prisma, React, Socket.IO, or any I/O.
- Every hand is an append-only event log and must be fully replayable.
- TypeScript strict mode everywhere.
- Environments: `development` / `staging` / `production` — never commit `.env`.

## Roadmap

See `docs/architecture/`. Phases: foundation → auth → poker engine → multiplayer
→ database → lobby → mobile table → hand history → admin → security review.
