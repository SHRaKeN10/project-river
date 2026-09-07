# ADR-0033: Closed-alpha invite codes

Status: Accepted — 2026-09-07 (Phase 3 — the alpha gate; feature freeze exception)

## Context

The platform is going into a **closed** alpha with 10–20 invited people. A
wide-open `POST /api/auth/register` is the wrong door for that: anyone who finds
the URL can create an account, and there is no way to know who is actually in
the test. We need a gate that is off by default (dev, tests, and prod until
flipped) and cheap to operate.

## Decision

An allow-list of **invite codes**. Nothing about the account model changes; the
gate is one env flag plus a small table.

### `INVITE_ONLY`

An env flag, default `false`. Read at **request time** (not boot), so it can be
toggled with `fly secrets set` + the automatic machine restart, no redeploy.
`false` → registration behaves exactly as before.

### `InviteCode`

```prisma
model InviteCode {
  code        String    @unique   // "river-abcd-ef2345", unambiguous alphabet
  createdById String?              // the admin who minted it
  maxUses     Int       @default(1)
  usedCount   Int       @default(0)
  expiresAt   DateTime?
  note        String?              // "twitter batch 1", a person's name
}
```

`User.invitedViaCode` records which code an account used (closed-alpha tracking).

### Minting — admin only

`POST /api/auth/invites` (`@Roles(ADMIN)`) with `{ maxUses?, expiresInHours?,
note? }` → `{ code, maxUses, usedCount, expiresAt, note, createdAt }`.
`GET /api/auth/invites` lists them with usage. Codes are logged to the audit
trail (`INVITE_CREATED`).

### Redemption — atomic, inside the register transaction

`register` gains an optional `inviteCode`. When `INVITE_ONLY`:

- no code → `INVITE_REQUIRED` (403).
- a code → it is redeemed **inside the same `$transaction` as the account is
  created**, via a single guarded statement:

  ```sql
  UPDATE "InviteCode" SET "usedCount" = "usedCount" + 1
   WHERE "code" = $1 AND "usedCount" < "maxUses"
     AND ("expiresAt" IS NULL OR "expiresAt" > now())
  ```

  Zero rows affected → `INVITE_INVALID` (403). Because the check-and-increment
  is one atomic UPDATE, a `maxUses: 2` code redeemed by five simultaneous
  sign-ups lets **exactly two** through - verified in the e2e. A failed account
  create rolls the redemption back, so a code is never burned by a 409.

  Codes are matched case-insensitively (stored lower-case). A redemption is
  audited (`INVITE_REDEEMED`).

### Client

The mobile register screen always shows an "Invite code" field. The server is
the authority: in open mode the field is ignored; in closed mode it is
required. No "am I in invite-only mode?" round-trip.

## Consequences

- New `InviteCode` table + `User.invitedViaCode` column + migration
  `20260907120000_invite_codes` (additive).
- New env `INVITE_ONLY`; new error codes `INVITE_REQUIRED` / `INVITE_INVALID`.
- To open the alpha: `fly secrets set INVITE_ONLY=true`, then mint codes with
  `POST /api/auth/invites` and hand them out. To end it: `INVITE_ONLY=false`
  (or `unset`).
- Not built (deliberately, per the freeze): per-invite chip bonuses, invite
  trees / referral tracking beyond `invitedViaCode`, a self-serve "request an
  invite" flow, an admin UI (use the REST endpoint or `curl`).
