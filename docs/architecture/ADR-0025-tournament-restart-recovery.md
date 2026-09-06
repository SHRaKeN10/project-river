# ADR-0025: Tournament restart recovery

Status: Accepted — 2026-09-05 (Phase 2, follow-up to ADR-0024)

## Context

A running tournament lived entirely in one process's memory: the
`TournamentRunner` coordinator, every `TournamentTableRunner`, all seating,
every in-progress hand, the standings-in-progress, the hand-for-hand flag, the
level timer. Postgres held only `Tournament` config + status + the clock anchor
(`startedAt`/`pausedMs`/`pausedAt`) + `TournamentEntry` rows whose `stack` was a
lagging cache. A process restart mid-tournament left the row stuck `RUNNING`
with no coordinator and no way back.

The single-process architecture (ADR-0019/0020: coordinator + all its tables in
one API machine) stays. Recovery had to work within it - no distributed table
ownership, no second coordinator, no second source of truth.

## Decision

### Source of truth

| what                                                            | where                                         | on recovery                                                                |
| --------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------- |
| identity, config, blind schedule                                | Postgres `Tournament`                         | read (immutable)                                                           |
| status (`RUNNING`/`FINISHED`/…)                                 | Postgres `Tournament`                         | read; drives the boot scan                                                 |
| level-clock anchor (`startedAt`)                                | Postgres `Tournament`                         | read; re-anchors the clock                                                 |
| settlement (`resultsJson`, per-entry `finishPosition`/`payout`) | Postgres                                      | authoritative once written                                                 |
| **all live runtime state**                                      | **Redis, one key** `tournament:<id>:snapshot` | **the single runtime source**                                              |
| `TournamentEntry.stack`                                         | Postgres                                      | **ignored** - denormalised REST-view cache only, rebuilt from the snapshot |

Because the Redis checkpoint is the _only_ runtime source, recovery never has
to reconcile "Redis says X, Postgres says Y" for anything that matters to
resuming play. The two Postgres values it does read (`status`, `startedAt`)
change only at `start()` / settlement and are cross-checked against
`snapshot.startedAtMs`.

Tournaments have no hand-history / event log (unlike cash `PokerHand`), so
recovery does **not** use replay. It does not need to: the engine's `GameState`
is a complete, self-contained snapshot of an in-progress hand (deck order +
cursor, board, betting round, per-player contributions, street, acting seat) -
the resume point _is_ the state.

### The checkpoint

`TournamentRunner.snapshot()` is a flat, JSON-safe capture (never class
instances / timers) - versioned (`v: 1`), stamped with `startedAtMs` (cross-check),
`writtenAtMs`, a monotonic `seq`, and a `phase` (`running` | `finished`):

- coordinator scalars: schedule, entrants, startingStack, seatsPerTable,
  prizePool, paidPlaces, name, gameType, `eliminatedCount`, `roundNumber`,
  `chopGroups`, `handForHand`;
- every entry: entryId, userId, username, avatarUrl, stack, `finishPosition`,
  `tableId`, `pendingBust`;
- every table: `engineConfig` + `pendingConfig` (blinds/ante now and next),
  the full `GameState`, `handNumber`, `previousPositions`, `lastSeqByUser`
  (stale-action protection), `revealedSeats`, `paused`, `held`,
  `handStartStacks`, and the seat roster (written all-disconnected).

The `GameState` (with the deck) is **server-side only** - it goes to Redis,
never to a client; the gateway projects it per viewer exactly as in normal play.
No RNG seed is ever stored: the in-progress hand's deck order was already
committed at that hand's `START_HAND`, and the next hand shuffles fresh from
`CryptoRandomProvider` (stateless).

### When it is written

`checkpoint()` fires **after every player-visible state change** (so a mid-hand
crash resumes on the _exact_ same decision) and at every boundary:

1. `start()` - initial seating;
2. every `state` table notification (each action / street);
3. `onHandComplete` - synchronously, _before any await_, once busts are recorded
   as pending and seats freed (a consistent, resumable intermediate);
4. end of `afterHand` - after `finalizeRound` + `planBalance`, _before_
   `maybeFinish`;
5. after `scheduleLevelAdvance` applies a new level.

`maybeFinish` is **not** checkpointed - it is deterministic and idempotent
(payouts keyed by `tpay:<entryId>`, `status: FINISHED` an upsert), so recovery
simply re-runs it. On success it writes one `finished` marker (15-min TTL) so a
client reconnecting in the settle window is still told the outcome.

The manager coalesces writes per tournament: "at most one in flight + the
newest queued", so a busy 200-player field never backs up more than one blob
under Redis latency. TTL 2h (matches the cash game).

### The ordering guarantee

A crash between an in-memory mutation and the checkpoint that would record it
lands recovery on the _previous_ checkpoint, whose `GameState` is a valid
earlier resume point. `finalizeRound` is idempotent - it keys off
`pendingBust !== null && finishPosition === null` and clears `pendingBust` when
it runs - so `resumeFromSnapshot` calls `afterHand()` once and it either
finishes an interrupted round exactly once or no-ops a completed one.
`planBalance` is deterministic, so re-running `runBalance` from either the
pre-move or post-move seating produces the same result. Settlement uses no RNG.

A reconnecting client's `clientSeq` re-send after a lost checkpoint is _accepted_
(the restored `lastSeqByUser` is one behind), so no action is silently dropped.

### Recovery sequence

`TournamentManager` implements `OnApplicationBootstrap`:

1. scan `Tournament` where `status IN (RUNNING, PAUSED)`;
2. for each, `recover(id)` - guarded by `runners` + an in-flight `recovering`
   map so **two runners for one tournament are impossible**;
3. read `tournament:<id>:snapshot` (retried on a transient Redis error);
4. `new TournamentRunner(id, deps)` → `resumeFromSnapshot(snapshot, row.startedAt)`:
   validate (`v`, id, `startedAtMs`, `phase`, shape, **`Σ stack == startingStack × entrants`**);
   rebuild scalars + entries + every table runner (`hydrate`); re-anchor the
   level clock; `resumeAfterRestart()` each table (mid-hand → the acting player
   gets `2 × actionTimeoutMs` grace to reconnect; between hands → schedule the
   next); re-persist `stack` / `finishPosition` to Postgres (idempotent); run
   `afterHand()` once;
5. register the runner (unless recovery _finished_ the tournament - it was on
   its last hand - in which case the settle path already ran and there is
   nothing live to register).

The gateway's `tournament:watch` awaits an in-flight recovery
(`ensureRunner`), tells a reconnecting busted player their finish, and - if the
tournament finished during the reconnect window - serves the standings from the
`finished` marker.

### Fail closed

A missing / stale (`startedAtMs` mismatch) / wrong-version / mis-shaped /
chip-inconsistent checkpoint → **no runner, row untouched, loud
`RECOVERY_FAILED` log**. Recovery never calls `seatDraw` on a bad snapshot; it
never invents chips, hands, seats or results. A stuck tournament is fully
recoverable by a human (inspect, or `CANCEL` which refunds every entrant).
`PAUSED` is scanned defensively though the coordinator never sets it yet.

### Registration

`REGISTERING` → no runner, untouched. `RUNNING`/`PAUSED` → recovered.
`FINISHED`/`CANCELLED` → never spawn a runner (the boot scan filters them, and
`doRecover` re-checks the row). Registration is never reopened.

## Files changed

- `apps/api/src/tournaments/tournament-recovery.ts` (new) - the snapshot types,
  `TOURNAMENT_SNAPSHOT_VERSION`, `TournamentRecoveryError`
- `apps/api/src/tournaments/tournament-runner.ts` - `snapshot()`,
  `resumeFromSnapshot()`, `checkpoint()` at the 5 boundaries, `makeTableRunner`
  helper, `persistFinishPositions`, `deps.persistSnapshot`
- `apps/api/src/tournaments/tournament-table-runner.ts` - `snapshot()`,
  `hydrate()`, `resumeAfterRestart()`
- `apps/api/src/tournaments/tournament-manager.ts` - `RedisService`,
  `OnApplicationBootstrap` boot scan, `recover` / `doRecover` / `recoverAll` /
  `ensureRunner` / `finishedResults`, coalesced Redis checkpoint I/O
- `apps/api/src/realtime/tournament.gateway.ts` - `onWatch` awaits recovery,
  handles reconnecting busted / finished
- `apps/api/src/tournaments/tournament-recovery.spec.ts` (new),
  `apps/api/test/tournament-recovery.e2e-spec.ts` (new)

No schema change. No change to tournament rules, payouts / chops, hand-for-hand,
antes, PLO / Big O, or the gateway wire protocol.

## Tests

**`tournament-recovery.spec.ts` (7, unit, deterministic).** A `ForkableRng`
(mulberry32 with a public `state`) lets a test fork the RNG at the exact instant
a checkpoint was captured and prove:

- a checkpoint round-trips the in-progress hand **byte-identically** (deck,
  street, board, pot, contributions, acting seat) and the acting player's legal
  actions are unchanged;
- restarting from a spread of checkpoints (early / mid / late) reaches the
  **identical final standings + payouts** as never restarting (jam bots);
- the same for a 12-player / 3-table field restarted after a balance;
- recovery is a no-op-safe re-run of an interrupted round (checkpoint with
  pending, not-yet-finalised busts);
- the level clock survives a restart _with a downtime gap_ - anchored to the
  persisted `startedAt`, it does not reset;
- a stale / wrong-version / finished-marker / chip-inconsistent snapshot is
  rejected (`TournamentRecoveryError`) and fails closed;
- a busted player is never resurrected - finish position + seatless + stack 0
  all restored; chips conserved.

**`tournament-recovery.e2e-spec.ts` (4, real Postgres + Redis + sockets).**

- **full process restart**: start a 6-player / 2-table field, play, `app.close()`,
  stand a fresh app up on the same infra → the `OnApplicationBootstrap` scan
  rehydrates it, eliminations + chip total preserved exactly, clients reconnect
  to the new process and play it out to `FINISHED` with positions 1..6 and
  payouts summing to the prize pool, no double elimination;
- **mid-hand**: recover a hand in progress on the _same_ `handId` / street; a
  reconnecting client is handed that same hand; chips conserved;
- **fail closed**: `DEL` the checkpoint → `recover` spawns no runner, row still
  `RUNNING`;
- **finished marker**: a client reconnecting just after settlement still gets
  `tournament:finished`.

## Test results

API unit **105** (+7), API e2e **55** (+4). Engine 392, mobile 72. typecheck /
lint / format / build green.

## Limitations / cases that intentionally fail closed

- **No checkpoint for a `RUNNING` row** → no runner, loud log, no auto-retry on
  a later client reconnect (only the boot scan / an explicit `recover` call
  retries). A human decides: restore a snapshot, or `CANCEL` (refunds everyone).
- A recovered elimination's `TournamentEntry.eliminatedAt` is rewritten to the
  recovery time if the original fire-and-forget write was lost (the snapshot
  doesn't carry the bust timestamp). `finishPosition` - what standings depend
  on - is exact.
- The `finished` marker's 15-min TTL bounds how late a disconnected client can
  reconnect and still be told the outcome via the socket; after that they get
  the result from the REST view.
- `resumeAfterRestart` gives a mid-hand acting player `2 × actionTimeoutMs` to
  reconnect; a player slower than that is folded, exactly as a mid-play
  disconnect would.
- A checkpoint blob is a single Redis key; for fields far larger than 200
  players a per-table key set would write less, at the cost of cross-key
  consistency. Not needed at this product's scale (one card room).

## Next

Deployed bot soak (#6) - the final engineering-confidence gate. Then serious
human testing of Hold'em + PLO + Big O + tournaments before the Palace pitch.
