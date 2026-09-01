# ADR-0002: Authentication

Status: Accepted — 2026-09-01 (Phase 2 / STEP 3)

## Context

Free-to-play MVP needs email/password accounts, stateless auth for the eventual
WebSocket gameplay path, and an audit trail. No email service exists yet.

## Decisions

### Passwords

`argon2id`, OWASP baseline (memory 19 MiB, timeCost 2, parallelism 1). On login,
if the account doesn't exist we still run a dummy `argon2.verify` so response
timing doesn't leak account existence.

### Access tokens

Short-lived JWT (HS256), claims `{ sub, role, sid }`. Verified by a custom
`JwtAuthGuard` (no Passport - not worth the weight here). Registered as a
**global** guard: every route is protected unless marked `@Public()`.

**Trade-off accepted:** access tokens are _not_ checked against a revocation
list. Logout / password-reset / reuse-detection revoke the _session_ and its
refresh tokens, but an already-issued access token stays valid until it expires
(`JWT_ACCESS_TTL`, default 600 s). This is the standard stateless-access /
revocable-refresh model. If we later need instant kill, add a Redis
`sid`-blocklist checked in the guard - no schema change.

### Refresh tokens

Opaque 256-bit random strings, **never JWTs**. Stored as `sha256(token)` (the
token's own entropy makes a slow hash pointless). **Rotated on every use.**
Grouped under a `Session` row (the "family").

**Reuse detection:** presenting a refresh token whose row is already `revokedAt`
(i.e. it was rotated away) means the token was captured and replayed. Response:
revoke the entire session (all its refresh tokens), write a
`REFRESH_TOKEN_REUSE_DETECTED` audit event, return 401. Both attacker and
victim are forced to re-authenticate.

### Sessions

One per login. `logout` revokes the current session (from the `sid` claim).
A future "log out other devices" iterates `Session` rows. Changing the password
revokes every session for the user.

### Validation

`zod` schemas from `@river/shared-types`, applied per-route via a small
`ZodValidationPipe`. The mobile client reuses the identical schemas — the API
and client contract can't drift.

### Rate limiting

Redis fixed-window counter (`RateLimiterService`). Per-IP via a `@Throttle()`
guard on every sensitive route; additionally per-identifier inside
`login` / `password-reset` so a targeted account can't be brute-forced from
rotating IPs. Successful login clears the per-identifier bucket.

### Password reset & email verification

Real hashed, expiring, single-use tokens (`VerificationToken`), issued and
consumed properly. **No email is sent yet** — non-production responses return
the raw token (`devToken`) so clients can be built/tested; production returns
an identical empty body whether or not the account exists. `TODO(Phase 9)`:
wire an `EmailService`.

### Audit

`AuditService` writes append-only `AuditLog` rows for register, login
success/failure/blocked, logout, token-reuse, password-reset request/complete,
email-verification request/verified. Never throws into the request path.

## Endpoints

| Method | Path                                   | Auth   | Notes                      |
| ------ | -------------------------------------- | ------ | -------------------------- |
| POST   | `/api/auth/register`                   | public | 201, returns user + tokens |
| POST   | `/api/auth/login`                      | public | 200                        |
| POST   | `/api/auth/refresh`                    | public | 200, rotates               |
| POST   | `/api/auth/logout`                     | bearer | 204, revokes session       |
| GET    | `/api/auth/me`                         | bearer | 200                        |
| POST   | `/api/auth/password-reset/request`     | public | 202                        |
| POST   | `/api/auth/password-reset/confirm`     | public | 204                        |
| POST   | `/api/auth/email-verification/request` | bearer | 202                        |
| POST   | `/api/auth/email-verification/confirm` | public | 204                        |
