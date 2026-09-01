# ADR-0009: Poker engine hardening

Status: Accepted — 2026-09-01 (correctness pass before mobile UI)

## Context

Before building more UI, prove the engine. Added deterministic replay, a
test-only deck-injection path, deterministic side/split/all-in scenario tests,
an exhaustive invalid-action matrix, disconnect/reconnect coverage, a stronger
randomized simulation, and a machine-checked isolation boundary.

## Decisions

### `START_HAND` accepts an optional explicit `deck`

`{ type: 'START_HAND', …, deck?: Card[] }`. When present, the reducer deals from
it instead of shuffling `rng`. This is what makes a hand fully reproducible: the
application persists `{ deck, actions[] }` and `replayHand` re-runs it. The RNG
is still passed but unused when a deck is supplied.

### `replayHand(record)` (`reducer/replay.ts`)

Pure. Rebuilds `initGameState` + replays the recorded `EngineAction` sequence
through `reduce`, returning a bit-identical event stream and final state.
`HandRecord` is the persistence contract for STEP 8's hand history.

### Test kit (`src/testkit/`, excluded from the build)

- `deckBuilder.buildDeck({ order, holes, board, burns })` — constructs a 52-card
  deal order so each seat gets the requested hole cards and the board comes out
  as specified; fills the rest with the remaining cards.
- `handRunner.HandRunner` — thin harness over `reduce` with chip accounting and
  pot-award helpers.

### Engine isolation is machine-checked

`engine-boundary.test.ts` asserts `package.json` has no `dependencies` and no
source file imports a framework/DB/transport/UI module. An ESLint
`no-restricted-imports` rule on `packages/poker-engine/src/**` enforces it in
the editor too.

## Result

24 suites / 258 tests. Randomized simulation now runs ~18,600 hands checking
every invariant after every action. Full report and the honest limitations list:
`docs/poker-engine-test-report.md`.
