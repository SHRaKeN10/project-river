# ADR-0028: Run It Twice (NLHE cash)

Status: Accepted — 2026-09-06 (Phase 2, follow-up to ADR-0027)

## Context

"Run It Twice" is the standard online-poker variance reducer: when the last
players are all-in with cards still to come, deal the remaining board **twice**
and split every pot in half - each board decides one half. It is the most
requested cash feature after bomb pots and straddle.

Mechanically it is a **second run-out from the same deck**, then settlement run
per board on half-pots. `buildPots` already works purely off `totalInvested`
(board-independent), `evaluateShowdown` already takes the state's community
cards, and `awardPots` already handles a `Pot[]`. So this is orchestration on
top of primitives the engine already has - not a second showdown or pot engine.

Constraints:

- **NLHE cash only** (the API only enables it for NLHE; the engine ignores it
  for other variants). Tournaments / PLO / Big O are unmodified.
- **Reuse `buildPots`, `evaluateShowdown`, `awardPots` unchanged.**
- The decision is made **before** any run-out could trigger, and no player can
  "trigger" it - it is a passive table + per-player setting the engine consults
  at the run-out moment, so it can never race a player who still has action.
- Composes with bomb pot / straddle (those own the pre-flop; this owns the
  run-out).

## Decision

### When it happens

Inside `progress`, in the existing `shouldRunOut` branch (reached only after
`isBettingRoundComplete`), the engine runs two boards instead of one when all of:

- `state.runItTwice` is true (set at `START_HAND`), and
- there are community cards still to come (`communityCards.length < 5`), and
- at least two players are still contesting.

All-in on the river, or a hand decided by a fold, never runs twice (nothing to
run). A single-board hand is byte-for-byte unchanged.

### Two boards from one deck

`runOutTwoBoards`: deal the first board with the normal
`FLOP`/`TURN`/`RIVER_DEALT` events, then deal every remaining street a second
time from where the first board left the deck (cursor-based, no reuse) - the
cards dealt **before** the all-in are shared. The second board arrives as one
`SECOND_BOARD_DEALT { cards }` event and lives in `GameState.secondBoard`.

So an all-in on the flop shares the flop and runs two turn/rivers; an all-in
pre-flop runs two fully independent boards.

### Settlement

`settleTwoBoards`: `collectBets` + `buildPots` + dead-money refunds **once**
(pots are board-independent). Run It Twice always follows an all-in run-out, so
every hand is tabled - no muck logic. Then for each board: `evaluateShowdown`
against that board's cards, `awardPots` on **half-pots** (`ceil(pot/2)` to
board 1, `floor(pot/2)` to board 2 - the odd chip goes to the first board), emit
`POT_AWARDED { board: 1 | 2 }`. Credit the union of both boards' awards. Total
awarded per pot = `ceil + floor` = the pot, so chips are conserved exactly.

### Engine surface

- `GameState.runItTwice: boolean`, `GameState.secondBoard: readonly Card[]`.
- `START_HAND.runItTwice?: boolean` - stored (`&& holeCards === 2`, so
  non-Hold'em silently runs one board).
- `SECOND_BOARD_DEALT` event; `POT_AWARDED.board?: 1 | 2`.
- `HandRecord.runItTwice` - a hand that ran twice replays byte-identically (no
  RNG in settlement; the deck is fixed).

### Server / persistence

- `PokerTable.runItTwiceEnabled` (true at creation for NLHE, like the others).
- `PokerTableSeat.runItTwiceOn` - the sticky per-player "armed" flag, persisted
  on the seat row (cold restart) and the Redis roster snapshot (warm), like
  `sittingOut` / `straddleOn`.
- `player:runItTwice { on }` -> `TableRunner.setRunItTwice`.
- `TableRunner.onStartHand`: run it twice when `runItTwiceEnabled`, the variant
  is Hold'em, and every dealt-in player has it armed. A subset that later
  reaches an all-in run-out is then guaranteed all-armed too, so the decision is
  safe to make at the deal.
- `PokerHand.ranItTwice` = `state.secondBoard.length > 0` at completion (the
  true outcome - a hand set to run twice that folds never actually does).
  `replayForViewer` feeds it back to `replayHand`.
- Restart is trivial: the whole run-out + settlement happens inside one
  `reduce()` call, so there is no persistable "between boards" state - the
  snapshot is either before the triggering action (recovery replays it,
  deterministically producing the same two boards) or after the completed hand.
- `PATCH /tables/:id/config` gains `runItTwiceEnabled`, applied live.

### Projection / mobile

- `TableStateView.secondBoard` + `runItTwice: { enabled, armed } | null` +
  `youRunItTwice`.
- Mobile: the community board renders a second row of cards under a "RUNNING IT
  TWICE" label when `secondBoard` is non-empty; `POT_AWARDED` feed lines say
  "(board 1)" / "(board 2)"; a "Run it twice - On/Off" row in the table menu.

## Why the sticky toggle, not an interactive prompt

An interactive "run it twice? [yes/no]" prompt mid-hand needs new events, a
decision timer, disconnect handling, and a runner pause between "betting closed"
and "deal boards". The sticky per-player toggle ("always run it twice") is what
the major online rooms actually ship and is the correct online equivalent of the
dealer asking. An interactive prompt can be layered on later without changing
the engine.

## Consequences

- No new betting, pot or evaluation logic - `buildPots`, `evaluateShowdown`,
  `awardPots` and the deck/RNG are reused verbatim.
- Every existing single-board hand (fold-outs, river all-ins, non-Hold'em) is
  unchanged; all 425 prior engine tests pass untouched.
- A run-it-twice hand still counts toward the bomb-pot cadence like any other.
