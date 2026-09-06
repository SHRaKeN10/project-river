# ADR-0024: Tournament antes in the engine

Status: Accepted — 2026-09-05 (Phase 2, follow-up to ADR-0023)

## Context

Every tournament follow-up so far (ADR-0019 → ADR-0023) has carried `ante`
through the stack - `BlindLevel.ante`, `TableConfig.ante`,
`TournamentTableRunner.setLevel({ ante })` - but the **engine reducer never
read it**. `standardBlindSchedule` sets `ante = bigBlind` from level 3, so
tournaments have been playing that structure blinds-only.

### Which ante model

The codebase disagreed with itself: `BlindLevel.ante` was documented
"big-blind ante posted by the player in the big blind", while
`TableConfig.ante` said "per-player ante". This PR implements the **per-player
(classic) ante** - every player dealt into the hand posts `config.ante` before
the blinds - because:

- `TableConfig.ante` (what the reducer actually consumes) already says so;
- a per-player ante is the general case; the short-stack / multi-all-in /
  multi-side-pot interactions it creates are exactly where pot bugs hide, and
  are the point of covering it properly.

The stale `BlindLevel.ante` comment is corrected here.
`standardBlindSchedule`'s `ante = bigBlind` value is **unchanged** - it is a
seed/test helper, a production tournament supplies its own `blinds` array with
whatever ante schedule the room wants. (A "one poster posts a full big blind"
big-blind ante, if ever wanted, is a distinct, smaller follow-up.)

## Decision

### Ante posting

At `START_HAND`, immediately after `HAND_STARTED` and **before the blinds**,
`postAntes` walks the seats in ascending order and, for every player being
dealt in (`status === Active`, `stack > 0`), posts `min(ante, stack)`:

```
postAnte(player, amount):
  committed = min(amount, player.stack)
  player.stack        -= committed
  player.totalInvested += committed          # NOT currentBet
  if player.stack == 0 and in-hand: player.status = ALL_IN
```

- The ante lands in `collectedPot` and the player's `totalInvested`, **never in
  `currentBet`** - so it is dead money that does not reduce what anyone owes to
  call. The big blind still owes a full call after everyone has anted.
- A player the ante empties is `ALL_IN` for the hand and posts no blind.
- `ANTE_POSTED { seat, amount }` (the event already existed, unused) is emitted
  per poster, plus `PLAYER_WENT_ALL_IN` when the ante flattens them.
- Levels with `ante === 0` skip `postAntes` entirely - byte-identical to
  before this PR (all 366 pre-existing engine tests unchanged).

### Blind posting after an ante

`postBlind` now returns early when the ante has already moved the player
all-in (`paid === 0 && status === ALL_IN`): no phantom `BLIND_POSTED { amount:
0 }`, no duplicate `PLAYER_WENT_ALL_IN`. `round.currentBet` is still the full
big blind even when the BB is all-in for less (the pre-existing short-BB path).

### Side pots

No pot-manager change. `buildPots` already works purely off each player's
`totalInvested` + `folded` flag, so antes flow into the correct main / side
pots automatically:

- a folded player's ante stays in the main pot as dead money;
- an ante-only short all-in is capped at its ante contribution and eligible for
  exactly the pot layer it reached;
- N players all-in at N different stack sizes (from antes, blinds, or bets in
  any mix) build N contiguous pots.

### Chip conservation

`Σ stack` before a hand `= Σ stack` after. Antes move `stack → collectedPot →
winner.stack` within the hand; `chipsInPlay` (`Σstack + ΣcurrentBet + (complete
? 0 : collectedPot)`) is invariant after every action. `HAND_COMPLETED` nets
sum to zero because `startStack = stack + totalInvested` already folds the ante
in. Asserted after every action across ~4,500 fuzzed anted hands (stacks
deliberately at / below the ante) and in every scripted scenario.

### Determinism / replay

`postAnte` / `postAntes` consult no RNG. An anted hand replays bit-identically
from its `HandRecord`.

## Files changed

- `packages/poker-engine/src/player/player.ts` - `postAnte()` (+ export)
- `packages/poker-engine/src/reducer/reduce.ts` - `postAntes()`, called in
  `startHand`; `postBlind` early-return for an ante-induced all-in
- `packages/poker-engine/src/tournament/blind-schedule.ts` - corrected the
  `BlindLevel.ante` / `standardBlindSchedule` docs (per-player, not big-blind)
- `apps/mobile/src/features/table/layout.ts` - one feed line for `ANTE_POSTED`
- tests: `reducer/antes.test.ts` (new, 20), `player/player.test.ts` (+6),
  `features/table/layout.test.ts` (+1 assertion)

No change to: the tournament coordinator, `TournamentTableRunner`, the
pot-manager, the action-validator, payouts / chops, hand-for-hand, shared
types, or any DB schema. `setLevel({ ante })` already plumbs the value; antes
switch on automatically as the level clock advances.

## Tests added

**`reducer/antes.test.ts` (20)** - posting order + exact pot (3-handed,
heads-up, 9-handed); ante is not a voluntary bet (BB still owes a full call);
`ante 0` posts nothing; sitting-out player does not ante; the short-stack
matrix (stack `>`, `==`, `<` ante; `== ante + SB`; between ante and BB;
`<` both; everyone all-in from the ante); side pots (short ante-only all-in
wins a main pot of every ante; three stack sizes → three pots; folded player's
ante is dead money; fold-around → BB sweeps the antes); dead small blind still
collects antes; a **~4,500-hand fuzz** asserting conservation after every
action and zero-sum nets, with the sub-ante all-in path hit hundreds of times;
replay determinism.

**`player/player.test.ts` (+6)** - `postAnte` moves to `totalInvested` only,
caps at the stack / goes all-in, exact-stack all-in, no-op on 0, rejects a
bad amount.

## Test results

Engine **392** (+26). API unit **98**, API e2e **51** (the tournament and
gateway e2e jam-bot fields now climb through the ante levels unchanged).
Mobile **72**. typecheck / lint / format / build / `expo export` green.

## Edge cases discovered

- With `standardBlindSchedule`'s `ante = bigBlind`, a full 9-handed table puts
  **9 BB into antes per hand from level 3** - a very heavy structure. It is
  correct and conserved; it is just not what a real room would run. Production
  tournaments pass their own `blinds`; the `standardBlindSchedule` helper's
  value was left as-is per the task's framing.
- BB all-in for less than the big blind purely from the ante: `round.currentBet`
  stays the full BB; a caller's excess is sorted out by `buildPots` /
  `returnUncalledBet` exactly as for a short-stacked BB today.
- Every player all-in from the ante (`actingSeat === null` after `START_HAND`):
  `progress` detects the complete betting round, runs the board out, and
  settles - no stuck hand.

## Next

Restart recovery (#5), then a deployed bot soak (#6). Then serious human
testing of Hold'em + PLO + Big O + tournaments before the Palace pitch.
