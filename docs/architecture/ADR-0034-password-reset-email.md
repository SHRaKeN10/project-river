# ADR-0034: Password-reset email (Resend)

Status: Accepted — 2026-09-07 (alpha prep — feature-freeze exception)

## Context

Password reset was fully built except for the last step: the token was only
logged, never emailed (`logDevToken`, "TODO Phase 9"). Before humans touch the
alpha they need a way to recover an account without an operator in the loop.

Scope is deliberately tiny. No email verification wiring, no marketing email,
no notification preferences, no HTML template system — just "send the reset
token to the user's inbox."

## Decision

### `Mailer` seam

Mirrors the `ErrorReporter` seam (ADR-0030):

- `Mailer` — abstract `send({ to, subject, text })`.
- `ConsoleMailer` — default. Logs, never sends. Used in dev, tests, and in
  production until a key is set.
- `ResendMailer` — a ~20-line `fetch` to `https://api.resend.com/emails`. No
  SDK, no new dependency. Non-2xx → throw.

`MailModule` is `@Global`; the factory picks `ResendMailer` when
`RESEND_API_KEY` is set, `ConsoleMailer` otherwise.

### Env

| var              | default                                 | notes                                             |
| ---------------- | --------------------------------------- | ------------------------------------------------- |
| `RESEND_API_KEY` | _unset_                                 | unset ⇒ mail is logged, not sent                  |
| `MAIL_FROM`      | `Project River <onboarding@resend.dev>` | must be a Resend-verified sender for real domains |

`onboarding@resend.dev` is Resend's shared sandbox sender — it works with no
domain setup, which is enough to start the alpha.

### Wiring

`AuthService.requestPasswordReset` sends the token after persisting it. The
send is **best-effort**: a provider failure is logged (`event:
password_reset_email_failed`) and the HTTP response is still a bland `202` — a
mail outage must not become a user-enumeration oracle. The pre-existing
dev/test path (`devToken` in the non-prod response) is untouched, so the e2e
suite still drives resets without a mailbox.

### Token consumption is now atomic

`consumeVerificationToken` was a check-then-update with a TOCTOU window. It is
now a single guarded `updateMany` (`WHERE tokenHash … AND consumedAt IS NULL
AND expiresAt > now()`), so concurrent confirms can't both succeed. This also
covers the email-verification token path (same helper). Covered by a new
"lets exactly one of several concurrent confirms through" e2e.

### Mobile

`ForgotPassword` + `ResetPassword` screens behind a "Forgot password?" link on
the sign-in screen. The user pastes the code from the email (no deep linking —
that's infrastructure this alpha doesn't need). On success every other session
is already dead server-side; the screen sends them to sign in again.

## Consequences

- New `apps/api/src/mail/` module; new env `RESEND_API_KEY` / `MAIL_FROM`.
- To turn on reset email in prod: `fly secrets set RESEND_API_KEY=…` (and
  `MAIL_FROM=…` once a domain is verified). Until then, reset still "works" but
  the token only appears in the logs.
- Not built (still, deliberately): email verification enforcement, delivery
  webhooks/bounce handling, templated or localized email, any second channel.
