# Load harness

Drives many concurrent tables/players against a running API and reports
latency + throughput. Not part of CI.

```bash
# 1. build + start the API (any mode)
pnpm --filter @river/api build && node apps/api/dist/main.js

# 2. one-time: create the `loadadm` ADMIN the harness logs in as
node apps/api/loadtest/setup-admin.mjs

# 3. seed N users and self-signed tokens (needs DB access + the API's JWT secret)
node apps/api/loadtest/seed-users.mjs 200 "$JWT_ACCESS_SECRET"

# 4. run: <tables> <playersPerTable> <seconds>
node apps/api/loadtest/run.mjs 25 8 60

# 5. remove the load users / tables / ledger rows afterwards
node apps/api/loadtest/cleanup.mjs
```

`run.mjs` logs in as `loadadm` to create the tables; without an admin it falls
back to whatever tables the lobby lists. `tokens.json` is generated and
git-ignored.

While a run is going, `GET /api/ops/metrics` (with the `loadadm` token) shows
live RSS, socket count, active tables, hands/min and the stuck-table count.
