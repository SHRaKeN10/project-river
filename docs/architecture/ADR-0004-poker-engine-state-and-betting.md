# ADR-0004: Poker engine — player, table, betting, action validation, game state

Status: Accepted — 2026-09-01 (Phase 3 / STEP 4, part 2a)

## Context

With cards/deck/shuffle/evaluator done (ADR-0003), part 2a adds the state model
and the betting rules. The `reduce()` reducer, pot construction, street
transitions, showdown, and the event log are part 2b.

## Decisions

### `player`

`PlayerState` is immutable. `currentBet` = chips in this betting round,
`totalInvested` = chips across the whole hand. `hasActed` tracks whether the
player has taken a voluntary action _at the current bet level_ — posting a
blind does not set it, so the big blind keeps its option. Pure helpers:
`commitChips` (caps at stack, flips to `AllIn`), `foldPlayer`, `markActed`,
`resetForStreet`, `resetForHand`. A player who ends a hand with no chips is
sat out.

### `table`

`TableConfig` (2–9 seats, blinds, ante, buy-in range) + seat selection +
button/blind assignment. **Moving-button** simplification: button → next
eligible seat, SB → next after that, BB → next after that. Heads-up: the button
is the SB and acts first pre-flop. Full dead-button / dead-SB rules are a later
refinement (they only affect exact fairness across sit-downs).

### `betting`

`BettingRound { currentBet, lastRaiseSize, lastAggressorSeat, minOpen }` +
pure `apply*` transitions over a `BettingContext { players, round, actingSeat }`.

**The one subtle rule — incomplete raises.** A full bet/raise (increment ≥
`lastRaiseSize`) re-opens the action: every other player's `hasActed` is
cleared. An all-in for _less_ than a full raise still increases `currentBet`
(others must call the extra) but does **not** re-open the action and does not
grow `lastRaiseSize`. This is entirely encoded in `hasActed`, so the validator's
"can this player raise?" check is simply **`!player.hasActed`**.

`isBettingRoundComplete` = hand decided (≤1 with cards) OR nobody can act OR
every ACTIVE player has `hasActed && currentBet === round.currentBet`.

### `action-validator`

`validateAction(ctx, seat, action)` is the single gate — the server rejects
anything it doesn't pass with `{ ok: true }`; the client's opinion is never
trusted. Typed `ValidationCode`s. `legalActions(ctx, seat)` enumerates options
with sizing bounds for the client's action bar (the server still re-validates
the chosen action).

Actions use **"raise to"** semantics: `BET`/`RAISE` `amount` is the total the
player's `currentBet` becomes, not the increment. `ALL_IN` is a convenience the
reducer expands.

### `game-state`

`GameState` is the complete immutable authoritative hand state — everything to
replay a hand is in it (the `deck` carries its seeded order + cursor). The
engine has no clock: `actionDeadline` is set by the application layer.
Selectors only (`getPlayer`, `playersInHand`, `nextActingSeat`, `toCall`,
`isHandOver`, …); mutation is the reducer's job (2b).

## Tests

95 new tests (176 engine total). Betting covers every `apply*` path incl. the
incomplete-all-in case and a chip-conservation sequence; the validator covers
out-of-turn / can't-check-facing-a-bet / below-min / over-stack / can't-raise-
after-incomplete-all-in and full `legalActions` enumeration; table covers
heads-up, 3-/6-handed positions and 12-hand button rotation.

Also fixed a `-0`/`Object.is` false-negative in an ADR-0003 property test.
