# Project River — single-node operations runbook

Closed-alpha topology: **one API process**, one Postgres, one Redis. The API is
the sole authority for live hands; Redis is socket fan-out plus a table-state
snapshot for restart recovery. Do **not** run two API instances against the same
database in this phase — table ownership is in-process only.

## Deploy — Fly.io (alpha target)

`fly.toml` at the repo root is set up for **one machine, no auto-stop** — the
API holds every live table in memory, so it must not be scaled or cycled
automatically. `docker/api.Dockerfile` builds it; `[deploy] release_command`
runs `prisma migrate deploy` once per release before traffic shifts.

First deploy (needs the `fly` CLI and a logged-in account):

```bash
fly launch --no-deploy --copy-config --name project-river

# Postgres — creates it and injects DATABASE_URL as a secret
fly postgres create --name project-river-db
fly postgres attach project-river-db

# Redis (Upstash via Fly) — prints a rediss:// URL; set it yourself
fly redis create
fly secrets set REDIS_URL="rediss://…"

# Auth secrets + the (native-app-irrelevant but required) CORS value
fly secrets set \
  JWT_ACCESS_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" \
  JWT_REFRESH_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" \
  CORS_ORIGINS="https://project-river.fly.dev"

fly deploy
```

Then seed tables and make yourself an admin:

```bash
fly ssh console -C "node prisma/seed.mjs"              # the standard 6-table ladder
# ...register through the app first, then:
fly ssh console -C "node prisma/promote-admin.mjs you@example.com"
```

Every later release is just `fly deploy` (migrations run in the release step).
`fly releases` lists them; `fly deploy --image <previous>` or `fly releases
rollback` reverts.

Health checks are wired in `fly.toml` to `GET /health/ready` (200 only when
Postgres **and** Redis are reachable). `GET /health/live` is the bare
process-up probe.

### Any other host

Same shape: build `docker/api.Dockerfile`, run
`node_modules/.bin/prisma migrate deploy` before starting, then
`node dist/main.js`. One instance only. Full env list in
`apps/api/.env.production.example`.

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

## Waitlist auto-seat

When a seat frees, the head of the waitlist gets a **hold** on it
(`TableSeatReservation`, `WAITLIST_CLAIM_WINDOW_MS`, default 25 s). A periodic
sweeper (`WAITLIST_SWEEP_MS`, default 5 s, also on boot) expires stale holds —
dropping the player's place — and re-promotes. All state is in Postgres and
there are no in-memory timers, so a restart needs no special handling. If a
seat looks stuck "reserved", check `SELECT * FROM "TableSeatReservation"` — an
expired row is cleared within one sweep. See ADR-0031.

## Monitoring

`GET /api/ops/metrics` (admin token) returns:

| field                                                       | watch for                                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `uptimeSeconds`                                             | unexpected resets = crash loop                                                                          |
| `memoryRssMb`                                               | steady growth = leak                                                                                    |
| `sockets`                                                   | connected clients on this node                                                                          |
| `tables.activeTables` / `seatedPlayers` / `handsInProgress` | load                                                                                                    |
| `tables.stuckTables`                                        | **should be 0** — a hand whose action clock lapsed >30 s past its timer; the runner queue may be wedged |
| `handsLastMinute`                                           | cash-game throughput; 0 while players are seated is suspicious                                          |
| `tournaments.running` / `playersRemaining` / `tables`       | live tournament roll-up (tournament tables never appear under `tables.*`)                               |
| `tournaments.handsLastMinute`                               | tournament throughput; `handsLastMinute` above is blind to tournament hands                             |
| `orchestrationErrors.total`                                 | **should stay flat** — coordinator failures outside any request; a climbing count needs a look          |
| `orchestrationErrors.byScope` / `lastMessage` / `lastAt`    | which coordinator, the most recent message, and when                                                    |

Also scrape `GET /health/ready` for dependency health.

### Error reporting

Every API failure returns `{ statusCode, code, message, requestId, timestamp }`
— `code` is stable (`NOT_FOUND`, `VALIDATION_FAILED`, `ANTI_RATHOLE_COOLDOWN`,
`INTERNAL`, …); `requestId` matches the `req.id` in the logs. 5xx and any
non-HTTP bug are logged with a stack and sent to the error reporter.

Set `SENTRY_DSN` (`fly secrets set`) to aggregate errors in Sentry — recommended
before human testing. Without it, errors still land in the structured logs
(grep for `"event":"error_captured"` or `"level":50`), just not aggregated.
`orchestrationErrors` on `/ops/metrics` is the at-a-glance counter either way.
See `docs/architecture/ADR-0030-observability.md`.

Leave `scripts/watch-metrics.mjs` running during a test session — it logs a
compact line on a schedule and shouts (`!!`) on `stuckTables > 0`, a process
restart, or the API going unreachable:

```bash
API_URL=https://project-river.fly.dev \
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=… \
node scripts/watch-metrics.mjs 20
```

`fly logs` is the other half — `TableRunner` / `TableManager` warnings and any
`cashOut FAILED … manual reconciliation needed` line.

## Closed alpha — invite codes

`fly secrets set INVITE_ONLY=true` (read per-request; the machine restarts, no
redeploy). Then, as an admin:

```bash
# mint a code good for 5 people, expiring in 7 days
curl -sX POST $API/api/auth/invites -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' \
  -d '{"maxUses":5,"expiresInHours":168,"note":"discord batch 1"}'

curl -s $API/api/auth/invites -H "authorization: Bearer $ADMIN"   # usage so far
```

Hand out `code`. To end the alpha: `fly secrets unset INVITE_ONLY`. See
`docs/architecture/ADR-0033-invite-codes.md`.

## Password-reset email (Resend)

Password reset works without email configured — the token just goes to the logs
(`grep 'password reset'`). Before recruiting testers, wire real delivery:

```bash
fly secrets set RESEND_API_KEY="re_..."
# optional once you've verified a domain in Resend; the default sandbox sender
# (onboarding@resend.dev) needs no setup:
fly secrets set MAIL_FROM="Project River <no-reply@yourdomain>"
```

Sends are best-effort: a Resend outage is logged (`event:
password_reset_email_failed`) and the API still returns a bland `202` so it
can't be used to probe which emails have accounts. See
`docs/architecture/ADR-0034-password-reset-email.md`.

## Admin table control

`PATCH /api/tables/:id/status` (admin) with `{ "status": "ACTIVE" | "PAUSED" | "CLOSED" }`.

- `PAUSED` / `ACTIVE` — toggles lobby visibility and new sit-downs.
- `CLOSED` — also tears the live runner down and returns every seated stack to
  its owner's wallet. Use this to drain a stuck table: close it, let players
  re-seat elsewhere, investigate the snapshot.

`POST /api/tables` (admin) creates a table. `apps/api/prisma/seed.mjs` seeds the
standard 6-table ladder (`pnpm --filter @river/api prisma:seed` locally, or
`fly ssh console -C "node prisma/seed.mjs"` in production). It's idempotent.

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
