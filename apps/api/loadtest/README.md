# Load harness

Drives many concurrent tables/players against a running API and reports
latency + throughput. Not part of CI.

```bash
# 1. build + start the API (any mode)
pnpm --filter @river/api build && node apps/api/dist/main.js

# 2. seed N users and self-signed tokens (needs DB access + the API's JWT secret)
node apps/api/loadtest/seed-users.mjs 200 "$JWT_ACCESS_SECRET"

# 3. run: <tables> <playersPerTable> <seconds>
node apps/api/loadtest/run.mjs 25 8 60
```

`run.mjs` also logs in as `loadadm` (must be an ADMIN in the DB) to create the
tables; without it, it falls back to whatever tables the lobby lists.

`tokens.json` is generated and git-ignored.
