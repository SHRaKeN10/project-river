# ADR-0003: Poker engine — cards, deck, shuffle, hand evaluator

Status: Accepted — 2026-09-01 (Phase 3 / STEP 4, part 1)

## Context

`@river/poker-engine` is the correctness core of the whole platform. It must be
pure (no NestJS / Prisma / React / Socket.IO / I/O), deterministic, and
exhaustively tested. This ADR covers the first four modules.

## Decisions

### Card model

The engine owns its own `Rank` (numeric enum, Two=2 … Ace=14) and `Suit`
(string enum, `'c'|'d'|'h'|'s'`). Numeric ranks make straight detection and
comparison trivial. It deliberately does **not** import the string enums in
`@river/shared-types` (that package depends on `zod`); the API maps between the
two at the wire boundary — the values line up 1:1.

`cardId` gives every card a stable `0..51` integer for de-duplication and
compact serialization.

### Deck

`DeckState` is plain immutable data — `{ cards: Card[52], cursor }` — so it can
live inside the engine's `GameState` and be serialized for hand replay.
`dealCard` / `dealCards` return a new state; nothing mutates. Dealing past 52
throws `DeckExhaustedError`.

### Shuffle

Fisher–Yates over the `RandomProvider` abstraction (ADR-0001). Pure. Draw
`nextInt(i+1)` — the provider's rejection sampling makes it an unbiased
permutation. `Math.random()` remains banned in the engine.

### Hand evaluator

`evaluate(cards)` takes 5–7 cards and returns a `HandRank`
(`{ category, tiebreakers[], cards[] }`). For 6–7 cards it takes the best of all
C(n,5) ≤ 21 sub-hands. `compareHandRanks` is a total order; `0` means a split.

- The **wheel** (A-2-3-4-5) ranks as a Five-high straight/straight-flush.
- A Royal Flush is just the top `StraightFlush` — not a separate category.
- `tiebreakers` are laid out so the paired categories fall straight out of a
  rank-frequency grouping sorted by (count desc, rank desc).

**Best-of-21, not a lookup table.** ~microseconds per showdown, and showdowns
are rare. `evaluate` is the only entry point, so a perfect-hash / lookup-table
evaluator can drop in later with zero call-site changes if profiling ever asks
for it.

### Testing & the oracle

`pokersolver` (MIT) is a **devDependency and test-only oracle** — engine source
never imports it. `oracle.test.ts` cross-checks our ordering of 25,000 random
7-card hand pairs against it; any disagreement fails CI.

`simulation.test.ts` deals 100,000 random 7-card hands and asserts the category
frequencies match published 7-card probabilities (High Card ~17.4%, Pair ~43.8%,
… Straight Flush ~0.03%), plus a pocket-Aces-vs-Kings equity check (~82%).

Plus fast-check property tests: shuffle is always a permutation; `evaluate`
never throws on any 7 distinct cards; best-of-7 ≥ every 5-subset; comparison is
reflexive and antisymmetric; strength is input-order-independent.

99 engine tests total.

## Not yet built (next STEP 4 parts)

`game-state`, `player`, `table`, `betting`, `pot-manager`, `action-validator`,
`street-manager`, `showdown`, `events`, `reduce()`.
