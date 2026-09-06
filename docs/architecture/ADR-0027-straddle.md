# ADR-0027: Voluntary UTG straddle (NLHE cash)

Status: Accepted — 2026-09-06 (Phase 2, follow-up to ADR-0026)

## Context

Live NLHE cash rooms let the under-the-gun player post a voluntary "straddle" —
a blind-sized raise (usually 2× the big blind) put in _before_ the deal, on top
of the normal blinds. It buys the last word pre-flop (the straddle acts after
everyone else and keeps the option to re-raise) and doubles the effective
stakes for that hand. It is the single most-requested "this plays like a real
cardroom" feature after bomb pots.

Mechanically a straddle is **the big-blind option, one seat along and one raise
level up**: the straddler commits chips into `currentBet` but — like a blind —
does not set `hasActed`, so when action returns to them they may check to close
or raise to re-open. The engine's tested BB-option path already does exactly
this. So, as with bomb pots (ADR-0026), this is a small domain-model addition,
not new betting logic.

Constraints:

- **NLHE cash only.** Tournaments / PLO / Big O are unmodified and never
  straddle (the API only enables it for NLHE).
- **Never combined with a bomb pot** — a bomb-pot hand has no blinds and no
  pre-flop round, so "blind → straddle → bomb pot" must be impossible.
- **Voluntary and configurable** (`straddle: { enabled, multiplier }` per table),
  not a hard-coded rule.
- All existing NLHE behaviour unchanged when a hand is not straddled.

## Decision

### The one rule: which mechanism owns the pre-flop

Exactly one of three shapes per hand, decided by the API before the deal:

| hand type | blinds | straddle       | pre-flop round                                     | first street |
| --------- | ------ | -------------- | -------------------------------------------------- | ------------ |
| bomb pot  | none   | never          | none                                               | flop         |
| straddled | SB+BB  | UTG posts N×BB | yes — first actor = UTG+1, straddle has the option | pre-flop     |
| normal    | SB+BB  | none           | yes — first actor = UTG, BB has the option         | pre-flop     |

The engine rejects `START_HAND` carrying both `bombPot` and `straddle`
(`STRADDLE_ON_BOMB_POT`); the API never forms a straddle on a hand it is about
to bomb.

### What a straddled hand is

1. SB and BB post as normal.
2. The UTG seat (`positions.firstToActPreflop`) posts `straddle.amount`
   (≥ 2× BB) into `currentBet`. `round.currentBet` becomes the straddle,
   `lastAggressorSeat` becomes the straddle seat, `lastRaiseSize` becomes
   `amount − BB` (a full raise for a 2× straddle). Like a blind, it does **not**
   set `hasActed`.
3. Pre-flop action starts at `nextSeat(straddleSeat)`.
4. When action returns to the straddle, it holds the option — check closes the
   round, raise re-opens it — unless it is all-in from the straddle (then it
   cannot act and the round closes when the calls complete).
5. Flop / turn / river / showdown are ordinary NLHE. `buildPots` is unchanged —
   the straddle is a normal bet, not dead money.

### Heads-up and short stacks

- **Disabled below 3 dealt-in players.** Heads-up "UTG" is the button, which
  already acts first; a button straddle is a different animal. `< 3` → the
  request is ignored, the hand plays normal (`STRADDLE_MIN_PLAYERS` if the
  engine is asked directly).
- Straddler `stack > amount` → normal straddle with the option.
- Straddler `stack === amount` → straddles all-in, no option.
- Straddler `stack < amount` → **cannot straddle**; the API does not form it and
  the hand plays normal. (A short all-in straddle under a full raise, if the
  engine is fed one anyway, does not grow the next player's minimum raise —
  matching `applyRaise`.)

### Engine changes (mirrors ADR-0026)

- `START_HAND.straddle?: { seat, amount }` — pure execution, no policy. Validates
  not-with-bombPot, `amount` integer ≥ 2× BB, `seat === firstToActPreflop`,
  `seats.length ≥ 3`.
- `PlayerActionType.POST_STRADDLE`, event `STRADDLE_POSTED { seat, amount }`.
- `postStraddle` helper; wired into the non-bomb branch after the blinds; first
  pre-flop actor shifted to `nextSeat(straddleSeat)`.
- `HandRecord` / `replayHand` / the `handRunner` testkit carry `straddle`; a
  straddled hand replays byte-identically (no RNG involvement).

### Server / persistence

- `PokerTable.straddleEnabled` (bool, default false — set true at creation for
  NLHE, like `bombPotEnabled`) + `straddleMultiplier` (int, default 2, admin
  min 2).
- `PokerTableSeat.straddleOn` — the per-player "armed" flag, **sticky** until the
  player turns it off. Persisted on the seat row (cold restart) and in the Redis
  roster snapshot (warm restart), same as `sittingOut`.
- `player:straddle { tableId, on }` socket event → `TableRunner.setStraddle` →
  the roster flag + `persistRoster`.
- `TableRunner.onStartHand`: if `straddleEnabled`, not a bomb hand, Hold'em, ≥ 3
  dealt-in, and the UTG seat has `straddleOn` and can cover the full amount →
  passes `straddle: { seat, amount }` to the engine. UTG is the
  `assignPositions(...).firstToActPreflop` seat — the same pure computation the
  engine does.
- `currentStraddle` (the straddle for the in-progress hand) is set in
  `onStartHand`, cleared in `onHandComplete` (a straddle never carries to the
  next hand — the armed flag does), and restored from the Redis snapshot on a
  warm mid-hand restart (it is also baked into `GameState`; the snapshot field
  just keeps `straddleView()` and the completed-hand record right).
- `PokerHand.straddleAmount` (0 = not straddled). The straddle _seat_ is not
  stored — `replayForViewer` recomputes it via `assignPositions`, deterministic.
- `PATCH /tables/:id/config` gains `straddleEnabled` / `straddleMultiplier`,
  applied live via `TableRunner.applyConfigPatch`.

### Projection / mobile

- `TableStateView.straddle: { active, seat, amount, multiplier } | null` (null
  when the table doesn't allow straddling) + `youStraddleNext` (the viewer has
  it armed) + `PublicSeatView.isStraddle` (the straddle seat this hand).
- Mobile: a "STR" chip on the straddle seat, a feed line for `STRADDLE_POSTED`,
  and a "Straddle (UTG) — On/Off" row in the table menu for a seated player.

## Consequences

- Reuses the BB-option betting path, `buildPots`, the existing deck/RNG, the
  event/replay system, the Redis snapshot + cold-restart seat pattern, and the
  admin config endpoint. No new betting logic.
- A straddled hand counts toward the bomb-pot cadence exactly like any other
  completed NLHE cash hand — the counter doesn't care.
- Losing the `straddleOn` flag on a full cold restart with no snapshot would
  cost one hand's straddle until the player re-arms; but it persists on the seat
  row, so that path is covered too.
