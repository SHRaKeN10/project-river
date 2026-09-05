# ADR-0013: Game variants — Omaha and pot-limit betting

Status: Accepted — 2026-09-05 (Phase 2, "the full game menu")

## Context

The engine has been Hold'em-only. Selling the platform to a live card room means
matching the games it actually spreads: Pot-Limit Omaha first, then five-card
Omaha hi/lo ("Big O"), then multi-table tournaments. This ADR covers the first
step — the variant framework and four-card PLO. Hi/lo split pots (Big O) and
tournaments are separate ADRs.

The guiding constraint: **Hold'em must behave exactly as before.** Every one of
the 267 pre-existing engine tests passes unchanged.

## Decisions

### `GameVariant` + `VariantRules`

`packages/poker-engine/src/variant/` is a new module. `GameVariant` is
`HOLDEM | OMAHA`. `rulesFor(variant)` returns the differences the rest of the
engine branches on:

| rule            | Hold'em    | Omaha       |
| --------------- | ---------- | ----------- |
| `holeCards`     | 2          | 4           |
| `holeCardsUsed` | `null`     | `2`         |
| `bettingLimit`  | `NO_LIMIT` | `POT_LIMIT` |

`TableConfig` gains a `variant` field; `createTableConfig` defaults it to
`HOLDEM`, so every existing call site and persisted config is unchanged. The
config flows into `GameState.config`, so `replayHand` reproduces an Omaha hand
with no extra plumbing.

### Dealing

`dealHoleCards` deals `rulesFor(config.variant).holeCards` cards per seat, one at
a time around the table, instead of a hard-coded two.

### Hand evaluation

New `evaluateHand(hole, board, holeCardsUsed)` in the hand-evaluator:

- `holeCardsUsed === null` → the existing best-of-7 (`evaluate`), so Hold'em is
  byte-identical and "playing the board" stays legal;
- `holeCardsUsed === 2` → the best of every `C(4,2) × C(5,3) = 60` split, i.e.
  exactly two hole cards and exactly three board cards.

`evaluateShowdown` reads the rule from `state.config.variant`. A generic
`combinations<T>(items, k)` helper backs the split enumeration.

### Pot-limit betting

`BettingContext` gains two optional fields — `potBeforeRound`
(`GameState.collectedPot`) and `bettingLimit` — both defaulting to the no-limit
behaviour when omitted, so no test context or projection call site had to change
signature.

`potLimitMaxTo(ctx, seat)` = `round.currentBet + pot + owed`, where
`pot = potBeforeRound + Σ currentBet` and `owed = round.currentBet −
player.currentBet`. For an opening bet this reduces to the pot size; facing a
bet it is the classic "call, then bet the pot" cap.

Enforcement is layered:

- `validateAction` rejects an over-cap `BET`/`RAISE` with a new
  `ValidationCode.ABOVE_MAXIMUM`;
- `legalActions` clamps the `max` sizing bound to the cap (and drops the `RAISE`
  option entirely in the rare state where even a minimum raise would exceed it);
- `applyBet` / `applyRaise` throw `BettingRuleError` past the cap as
  defence-in-depth — unreachable through `reduce`, which always validates first.

`expandAllIn` clamps a deep stack's `ALL_IN` to `potLimitMaxTo` — under pot
limit "all in" with 200bb behind becomes a pot-sized bet or raise, not a
200bb shove.

### Not in this change

The API and mobile app still create every table as `HOLDEM` (the
`createTableConfig` default). Wiring `PokerGameType.PLO` through the database,
the `gameType → variant` map, the four-card seat UI and a "Pot" bet button is
the follow-up integration PR.

## Tests

- `variant/variant.test.ts` — `rulesFor`, `isGameVariant`, `cardsNeeded`.
- `hand-evaluator/evaluate-omaha.test.ts` — the two-hole-card rule: a single
  suited hole card is not a flush; a five-card board straight is unplayable;
  quad board reads as trips in Omaha; `combinations` counts.
- `betting/pot-limit.test.ts` — `potLimitMaxTo` for opening / preflop /
  re-raise; `validateAction` and `apply*` accept the pot and reject a chip over.
- `reducer/omaha.test.ts` — four hole cards dealt; over-pot open rejected; a
  deep-stack all-in becomes a pot raise; a short stack still shoves; a full hand
  settled by the two-hole-card rule with chip conservation.
- `reducer/omaha-simulation.test.ts` — thousands of random pot-limit hands: no
  illegal action, chips conserved after every action, and no accepted bet or
  raise ever exceeds the pot at that moment.

## Result

Engine: **31 suites / 302 tests**. API unit **48**, API e2e **34**, mobile
**44** — all unchanged, confirming Hold'em is untouched.
