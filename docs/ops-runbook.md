# Project River — single-node operations runbook

Closed-alpha topology: **one API process**, one Postgres, one Redis. The API is
the sole authority for live hands; Redis is socket fan-out plus a table-state
snapshot for restart recovery. Do **not** run two API instances against the same
database in this phase — table ownership is in-process only.

## Deploy

1. Provision Postgres 16 and Redis 7 (managed or containers). Note their URLs.
2. Set the API environment (platform secrets, not a file):
   - `NODE_ENV=production`
   - `DATABASE_URL`, `REDIS_URL`
   - `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` — 48 random bytes each
     (`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`)
   - `CORS_ORIGINS` — comma-separated client origins. **Required**: the API
     refuses to boot in staging/production without it.
   - optional `TABLE_*` overrides (see `apps/api/.env.example`)
3. Build and release:
   ```bash
   pnpm install --frozen-lockfile
   pnpm --filter @river/api prisma:deploy   # runs pending migrations
   pnpm --filter @river/api build
   node apps/api/dist/main.js
   ```
4. Point the load balancer's health checks at:
   - `GET /health/live` — process up (restart policy)
   - `GET /health/ready` — Postgres + Redis reachable (traffic gate)

## Migrations

`prisma:deploy` is forward-only and safe to run on every release. Never run
`prisma migrate reset` or `migrate dev` against a shared database. Review new
migration SQL before release; take a DB snapshot first for anything that drops
or rewrites a column.

## Restart / recovery

On restart the API rebuilds each table from:

1. its Redis `table:<id>:snapshot` (full game state + roster, 2 h TTL) if present, else
2. the `PokerTable` / `PokerTableSeat` rows (roster + stacks as of the last hand).

An in-progress hand is restored but its action clock stays **unarmed until a
player reconnects** — a hand never auto-resolves against players who can't see it.
Every restored seat starts disconnected; the away sweep (see below) reclaims
seats nobody comes back to.

Expected impact of a rolling restart: sockets drop and reconnect; any hand
mid-street resumes once its acting player is back; a hand can't start with fewer
than two connected players.

If Redis is wiped, only in-flight hands are lost — completed hands, chips, and
rosters are all in Postgres. Players are re-seated from their last-hand stacks.

## Away players

A disconnected seated player is stood up automatically after `TABLE_AWAY_MAX_MS`
(default 2 min) **or** `TABLE_AWAY_MAX_MISSED_HANDS` (default 10), whichever comes
first. Their stack is returned to their wallet through the same idempotent
`standUp` path as a normal leave, and a `REMOVED_INACTIVE` error is emitted.

## Monitoring

`GET /api/ops/metrics` (admin token) returns:

| field                                                       | watch for                                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `uptimeSeconds`                                             | unexpected resets = crash loop                                                                          |
| `memoryRssMb`                                               | steady growth = leak                                                                                    |
| `sockets`                                                   | connected clients on this node                                                                          |
| `tables.activeTables` / `seatedPlayers` / `handsInProgress` | load                                                                                                    |
| `tables.stuckTables`                                        | **should be 0** — a hand whose action clock lapsed >30 s past its timer; the runner queue may be wedged |
| `handsLastMinute`                                           | throughput; 0 while players are seated is suspicious                                                    |

Also scrape `GET /health/ready` for dependency health.

## Admin table control

`PATCH /api/tables/:id/status` (admin) with `{ "status": "ACTIVE" | "PAUSED" | "CLOSED" }`.

- `PAUSED` / `ACTIVE` — toggles lobby visibility and new sit-downs.
- `CLOSED` — also tears the live runner down and returns every seated stack to
  its owner's wallet. Use this to drain a stuck table: close it, let players
  re-seat elsewhere, investigate the snapshot.

`POST /api/tables` (admin) creates a table. `apps/api/prisma/seed.ts` seeds a
default set for a fresh environment (`pnpm --filter @river/api prisma:seed`).

## Incident: a wedged table

1. `GET /api/ops/metrics` — confirm `stuckTables > 0`.
2. Identify it from logs (`TableRunner` / `TableManager` warnings name the id).
3. `PATCH /api/tables/:id/status {"status":"CLOSED"}` — frees seats and chips.
4. Capture `redis-cli GET table:<id>:snapshot` for a post-mortem.
5. Re-open with a fresh `POST /api/tables` if needed.

## Load ceiling (measured)

One Node process handled 200 concurrent players across 25 tables at ~0.7 CPU
core, p99 action round-trip ~22 ms, flat memory. See `apps/api/loadtest/`.
Re-run before raising table limits.
