# Phase 9 — deploy the closed alpha, step by step

Two parts: **A. the API on Fly.io**, then **B. the mobile app to testers**.
Run part A from the repo root; part B from `apps/mobile/`.

Everything the app needs is already in the repo (`fly.toml`, the Dockerfile,
`eas.json`). CI builds the exact production image on every push, so it's known
to work.

---

## Prerequisites

| You need         | Cost                                   | Notes                                                                                                           |
| ---------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A Fly.io account | Card required; alpha usage ~a few $/mo | https://fly.io/app/sign-up                                                                                      |
| The `flyctl` CLI | free                                   | `iwr https://fly.io/install.ps1 -useb \| iex` (Windows) · `curl -L https://fly.io/install.sh \| sh` (mac/linux) |
| An Expo account  | free                                   | https://expo.dev/signup                                                                                         |
| `eas-cli`        | free                                   | `npm i -g eas-cli`                                                                                              |
| Node 20+ locally | —                                      | already have it                                                                                                 |

```powershell
fly auth login
```

---

## Part A — API on Fly.io

### A1. Pick an app name

Fly app names are globally unique, so `project-river` is probably taken. Choose
something like `project-river-nick` and use it everywhere below as `<APP>`.

Set it in the four places that hard-code it:

```powershell
# from the repo root - replace project-river-nick with your name
$app = "project-river-nick"
(Get-Content fly.toml)                         -replace '^app = ".*"', "app = `"$app`""                 | Set-Content fly.toml
(Get-Content apps/mobile/app.config.js)        -replace 'project-river\.fly\.dev', "$app.fly.dev"      | Set-Content apps/mobile/app.config.js
(Get-Content apps/mobile/eas.json)             -replace 'project-river\.fly\.dev', "$app.fly.dev"      | Set-Content apps/mobile/eas.json
```

(macOS/Linux: `sed -i '' 's/project-river\.fly\.dev/'"$app"'.fly.dev/' apps/mobile/app.config.js apps/mobile/eas.json` and the `app =` line in `fly.toml`.)

Commit that so CI stays green and the mobile build picks it up:

```powershell
git add -A; git commit -m "chore: set fly app name to $app"; git push
```

### A2. Create the Fly app (no deploy yet)

```powershell
fly launch --no-deploy --copy-config --name <APP> --region iad
```

- `--copy-config` reuses the repo's `fly.toml` as-is.
- `--region` — pick one near your testers (`iad` US-east, `lhr` London, `syd` Sydney, …). It must match the DB and Redis region below.
- If it asks to tweak settings, say **no** — the config is already correct.

### A3. Postgres

```powershell
fly postgres create --name <APP>-db --region iad
fly postgres attach <APP>-db
```

`attach` sets the `DATABASE_URL` secret on your app automatically. Accept the
default database name. Pick the smallest size — an alpha barely touches it.

> If `fly postgres` is unavailable, use Managed Postgres instead:
> `fly mpg create` then `fly mpg attach <cluster>` — same result, sets
> `DATABASE_URL`.

### A4. Redis

```powershell
fly redis create
```

Answer the prompts (name it `<APP>-redis`, **same region**, the free
"Pay-as-you-go" plan, eviction **disabled**). It prints a URL **once** — copy
it. (`fly redis status <APP>-redis` shows it again.) It must be `rediss://`
(TLS) — the client picks up TLS from that scheme — then:

```powershell
fly secrets set REDIS_URL="rediss://default:XXXX@fly-<APP>-redis.upstash.io:6379"
```

> If `fly redis` is unavailable, make a free database at
> [console.upstash.com](https://console.upstash.com) (Redis, region near your
> app, TLS on) and `fly secrets set REDIS_URL="rediss://…"` with its URL.

### A5. The remaining secrets

```powershell
$access  = node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
$refresh = node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
fly secrets set JWT_ACCESS_SECRET="$access" JWT_REFRESH_SECRET="$refresh" CORS_ORIGINS="https://<APP>.fly.dev"
```

`CORS_ORIGINS` is required in production (the API refuses to boot without it).
The native app doesn't send an `Origin` header so the value only matters for a
future browser client — the app's own URL is a fine placeholder.

Check they're all set:

```powershell
fly secrets list
# expect: DATABASE_URL, REDIS_URL, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, CORS_ORIGINS
```

### A6. Deploy

```powershell
fly deploy
```

This builds `docker/api.Dockerfile` on Fly's builder, runs
`prisma migrate deploy` in a release step, then starts the machine. It's live
when the `/health/ready` check goes green (watch the deploy output, or
`fly status`).

### A7. Seed tables and make yourself an admin

```powershell
# the standard 6-table ladder (Rookie 1/2 … Diamond 50/100)
fly ssh console -C "node prisma/seed.mjs"

# register your admin account (use a real email + a long passphrase)
curl -X POST https://<APP>.fly.dev/api/auth/register `
  -H "content-type: application/json" `
  -d '{\"email\":\"you@example.com\",\"username\":\"admin\",\"password\":\"correct horse battery staple\"}'

# promote it
fly ssh console -C "node prisma/promote-admin.mjs you@example.com"
```

### A8. Verify

```powershell
curl https://<APP>.fly.dev/health/ready
# {"status":"ok","info":{"database":{"status":"up"},"redis":{"status":"up"}}, ...}
```

Watch live metrics during a test session (leave it running in a terminal):

```powershell
$env:API_URL="https://<APP>.fly.dev"
$env:ADMIN_EMAIL="you@example.com"; $env:ADMIN_PASSWORD="correct horse battery staple"
node scripts/watch-metrics.mjs 20
```

`fly logs` is the other half — watch for `TableRunner` / `TableManager`
warnings or `cashOut FAILED … manual reconciliation needed`.

### Later deploys

Just `fly deploy` — migrations run automatically. `fly releases` lists
versions; `fly releases rollback` reverts. `fly scale count 1` if a machine
ever multiplies (it must stay at **1**).

---

## Part B — mobile app to testers

`app.config.js` already points the app at `https://<APP>.fly.dev`. Confirm it
in the running app: the login screen and Settings both show `server: <host>`.

### B1. Link the Expo project

```powershell
cd apps/mobile
eas login
eas init
```

`eas init` creates the project and prints a **project ID**. Because the config
is a JS file, paste it into `app.config.js` inside `extra`:

```js
    extra: {
      apiBaseUrl: API_URL,
      socketUrl: SOCKET_URL,
      eas: { projectId: 'PASTE-THE-ID-HERE' },
    },
```

Commit that (`git add -A; git commit -m "chore: link eas project"; git push`).

### B2a. First session — Expo Go + `expo start` (both platforms, ~2 min)

Your machine serves the JS bundle, so it must stay awake and online.

```powershell
# apps/mobile/.env  (git-ignored)
"EXPO_PUBLIC_API_URL=https://<APP>.fly.dev" | Set-Content .env

npx expo start --tunnel
```

Testers install **Expo Go** (App Store / Play Store) and scan the QR / open the
link the terminal prints. `--tunnel` works even if they're not on your wifi.

### B2b. Better for Android — a standalone APK (laptop-free)

```powershell
cd apps/mobile
eas build --profile preview --platform android
```

Free. Produces an APK hosted by EAS; send testers the install link. The Fly URL
is baked in from `eas.json`. Android testers no longer need Expo Go or your
machine.

### B2c. iOS beyond Expo Go

A standalone iOS build needs an Apple Developer account ($99/yr). Without one,
iOS testers stay on **B2a** (Expo Go + your `expo start`).

### B3. Shipping JS changes

Once at least one tester has a build/Expo-Go session on the `preview` channel:

```powershell
cd apps/mobile
eas update --branch preview --message "what changed"
```

Testers get it on next app open. A native change (new dependency, config)
needs a fresh `eas build`.

---

## Onboarding the testers

Send them `docs/alpha-tester-guide.md` plus the link/APK. Ask for:

- expected-vs-actual, and roughly when
- for a wrong pot: the table + hand (you can pull the exact replay from
  `GET /api/hands/:id/replay` as admin)
- for a freeze/logout: what they were doing, and whether reopening fixed it

## If something's wrong

| Symptom                                        | Look at                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| App shows `server: localhost` or won't connect | `EXPO_PUBLIC_API_URL` / `app.config.js` default — rebuild or restart `expo start`                                   |
| `/health/ready` not 200                        | `fly logs`, `fly status` — Postgres or Redis unreachable                                                            |
| `stuckTables > 0` in metrics                   | `fly logs` for the table id, then `PATCH /api/tables/:id/status {"status":"CLOSED"}` as admin (frees seats + chips) |
| A player stood up mid-session                  | away window too tight — `fly secrets set TABLE_AWAY_MAX_MS=300000` and redeploy                                     |
| `cashOut FAILED` in logs                       | note the `idemKey`; the stack needs a manual `chips.move` — rare                                                    |
