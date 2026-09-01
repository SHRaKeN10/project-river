# ADR-0005: Poker engine — pot manager, streets, showdown, events, `reduce()`

Status: Accepted — 2026-09-01 (Phase 3 / STEP 4, part 2b — engine complete)

## Context

Parts 1 and 2a built the primitives and the betting rules. Part 2b ties them
together into the one function the rest of the platform calls.

## Decisions

### `pot-manager`

`buildPots(contributions)` → `{ pots, deadRefunds }` using the classic layered
algorithm (slice each distinct contribution level from everyone who reached it).
Folded players' chips stay in the pot as dead money; they are never eligible.
Adjacent layers with the same eligible set merge.

**Dead-money refund.** A layer contested by _no_ non-folded player (everyone who
bet that high then folded) is refunded to its contributors rather than lost.
This is the case that broke chip conservation in the first simulation run —
5-way pot, three short all-ins, the two big stacks both fold on the flop, and
the top 374 chips had no winner. Now returned.

`awardPots` distributes each pot to the strongest eligible hand(s); ties split
evenly with the odd chip going by position (first seat left of the button).
`returnUncalledBet` handles the live-betting-round overbet return.

### `street-manager`

Pure `nextStreet`, `dealHoleCards` (one at a time, twice around, from the SB —
matching a real deal), `dealFlop/Turn/River` (burn then deal), and
`shouldRunOut` (≥2 hold cards but ≤1 can act → deal the board with no betting).

### `showdown`

`showdownOrder` (last river aggressor first, else first left of the button),
`evaluateShowdown` (best 5 of 7 per contesting player). **No auto-muck yet** —
every non-folded player's hand is revealed at showdown. Muck-vs-side-pot logic
is fiddly and cosmetic; deferred. `HAND_MUCKED` exists in the event type.

### `events`

One discriminated union, `GameEvent`, covering `HAND_STARTED …
HAND_COMPLETED` (the master-prompt list plus `BET_RETURNED`,
`BETTING_ROUND_ENDED`, `ACTION_REJECTED`, `ACTION_TIMED_OUT`). No sequence
numbers or timestamps — the engine has no clock; the app stamps and persists.
Replaying the ordered events from `HAND_STARTED` reproduces the hand.

### `reduce(state, action, rng)` → `{ state, events[] }`

The single authoritative transition. **Pure and total** — an illegal action
yields an `ACTION_REJECTED` event and the _unchanged_ state; it never throws on
player input. All randomness comes through `rng`.

`EngineAction`: `START_HAND`, `PLAYER_ACTION`, `TIMEOUT` (→ auto check/fold),
`SIT_OUT`, `RETURN`.

**Auto-progression.** A single `PLAYER_ACTION` cascades as far as the rules
allow: apply the action → if the betting round closed, collect bets (return
uncalled), advance the street, deal community cards, reset for the new round →
repeat. If ≤1 player can act with ≥2 in the hand, run the board out. End on a
fold-walk or showdown with `HAND_COMPLETED`. So the last call of an all-in hand
emits `PLAYER_CALLED, FLOP_DEALT, TURN_DEALT, RIVER_DEALT, SHOWDOWN_STARTED,
HAND_REVEALED×, POT_AWARDED×, HAND_COMPLETED` in one result.

`ALL_IN` is expanded to the concrete bet/call/raise for the whole stack.
`actionDeadline` stays null in the engine — the app owns the clock.

## Tests

224 engine tests. `pot-manager` covers every side-pot shape incl. the
dead-money refund and odd-chip splits. `reduce` covers heads-up/3-/multi-way
hands, fold-walks, all-in run-outs, side pots, uncalled-bet return, timeouts,
rejections, button rotation. **`reduce/simulation.test.ts` plays ~14,000
random full hands and asserts chip conservation after every single action**,
plus a same-seed determinism check.

## Engine status: complete for NLHE

`packages/poker-engine` now supports a full No-Limit Hold'em hand end to end,
headless. Next (STEP 5) wires it to Socket.IO tables in `apps/api`.
