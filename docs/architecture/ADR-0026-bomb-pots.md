# ADR-0026: Bomb pots (NLHE cash)

Status: Accepted — 2026-09-06 (Phase 2, follow-up to ADR-0024)

## Context

Palace Poker runs "bomb pots" on their live NLHE cash tables: every so many
hands, the next hand skips the blinds and the preflop betting round entirely -
every dealt-in player antes a fixed amount into the middle and the dealer goes
straight to the flop. It is a popular action-booster and the room wants it in
the app.

Mechanically a bomb-pot contribution is **an ante with no preflop betting**.
ADR-0024 already built a per-player dead-money path (`postAnte` →
`totalInvested` + `collectedPot`, all-in on a short stack, `buildPots` works
purely off `totalInvested`). "Straight to the flop" is the existing
`openNextStreet` helper. So this feature is a small domain-model addition on top
of two mechanisms the engine already has, not a new engine.

Constraints going in:

- **NLHE cash only.** Tournaments, PLO, and Big O are never modified and never
  count toward the schedule.
- The "every N hands" schedule must be **server-authoritative** and
  **persisted/recoverable with the table state** - a process restart can neither
  cause a spurious bomb pot nor skip a scheduled one.
- **Exactly one** place in the code advances the schedule counter.
- All existing NLHE behaviour is unchanged on a non-bomb hand.

## Decision

### What a bomb-pot hand is

1. Button still rotates normally; `previousPositions` bookkeeping is unchanged.
2. **No SB/BB posted.** The bomb contribution replaces them.
3. Every player the engine would deal in (`seatsForNextHand`, i.e. engine status
   `Active`) contributes the **same** amount as dead money before cards are
   dealt. Sitting-out / empty / spectator seats contribute nothing.
4. A player with fewer chips than the contribution posts their whole stack and
   is all-in; no negative stacks; the existing side-pot logic handles it.
5. The contribution is **dead money** - it is added to `totalInvested` and the
   collected pot but is not a "current bet" anyone can call or raise over.
6. Hole cards are dealt normally from the existing CSPRNG deck.
7. **No preflop betting round.** The hand opens on the flop; first action is the
   normal post-flop first actor (`firstToActPostflop` = first live seat left of
   the button; the non-button player heads-up).
8. Flop / turn / river / showdown are ordinary NLHE from there, including
   post-flop all-ins and multiple side pots via the unchanged `buildPots`.

### Engine changes

- New `PlayerActionType.POST_BOMB` and events `BOMB_POT_STARTED`
  (`amount`, `eligibleSeats`) / `BOMB_POT_POSTED` (`seat`, `amount`), following
  the existing event/replay model.
- `START_HAND` gains an optional `bombPot: { amount }`. When present, `startHand`
  rejects it for any non-Hold'em variant (`BOMB_POT_HOLDEM_ONLY`) or a
  non-positive amount (`BOMB_POT_AMOUNT`), then: skips blinds/antes, posts the
  bomb via the generalised `postDeadMoney(state, amount, 'BOMB', events)` (the
  ADR-0024 `postAntes` renamed and parameterised), and after `dealHoleCards`
  calls `openNextStreet` instead of arming a preflop actor.
- `HandRecord` / `replayHand` carry `bombPot` so a recorded bomb hand replays
  bit-identically. No second RNG, no `Math.random()`, deck untouched.

### Server: the schedule counter

`interval` defaults to 15 and is configurable per table (`bombPotIntervalHands`).
`amount` defaults to the table's big blind and is configurable
(`bombPotAmount`, 0 = "use the big blind"). `bombPotEnabled` is set true at
table creation for `gameType === 'NLHE'` and false for everything else; false
leaves the table playing exactly as before.

Counter semantics (`handsSinceLastBomb`, starts at 0):

- `isBombPot = enabled && variant === Holdem && handsSinceLastBomb + 1 >= interval`
- a **completed bomb hand** → counter resets to `0`
- any **other completed hand** → counter `+= 1`

So with `interval = 15`: hands 1-14 are normal, hand 15 is a bomb pot, the
counter resets, hands 16-29 are normal, hand 30 is a bomb pot.

**The one and only place the counter advances is `TableRunner.onHandComplete`**,
after `releasePendingLeavers()` and before `persistRoster` / `notify`, so the
value that gets persisted and snapshotted is already the post-hand value. The
`currentHandIsBomb` / `currentBombAmount` runtime flags are computed once in
`onStartHand` (from the counter + config) and cleared in the same
`onHandComplete` block.

### Persistence & recovery

Dual persistence, matching how `handNumber` / button position already recover:

| restart kind                                     | source of the counter                                                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| warm (Redis snapshot present, possibly mid-hand) | `Snapshot.bombPot` = `{ handsSinceLastBomb, currentHandIsBomb, currentBombAmount }`, written on every `notify`  |
| cold (no snapshot)                               | `PokerTable.handsSinceLastBomb` column, written by `syncSeats` every hand alongside `handNumber` / `buttonSeat` |

An in-progress bomb hand is fully described by the engine `GameState` in the
snapshot (deck order, board, stacks, pot, `totalInvested`, acting seat), exactly
as any other in-progress hand - recovery replays nothing and deals nothing new.
A pre-bomb-pot snapshot simply has no `bombPot` field; hydration falls back to
`0`, which can at worst delay a bomb pot by a hand, never invent one.

Because the counter only ever advances in `onHandComplete`, and the snapshot is
written after that in the same turn, there is no "snapshot written before state
changed" window: a crash either loses the whole hand (counter unchanged, hand
re-dealt) or preserves the completed hand and its advanced counter together.

### Projection / wire / mobile

`TableStateView.bombPot` = `{ active, amount, nextInHands } | null` (null when
the table doesn't run bomb pots). `active` is true only during a bomb hand;
`nextInHands` counts down (0 = this hand). The gateway fills it from
`runner.bombPotView()`; spectators get the same public object and, as always,
never private hole cards. Mobile shows a "💣 BOMB POT" banner on the community
board with the contribution amount, and feed lines for `BOMB_POT_STARTED` /
`BOMB_POT_POSTED`; a normal NLHE hand renders exactly as before.

## Consequences

- Bomb pots reuse `postDeadMoney`, `openNextStreet`, `buildPots`, the existing
  deck/RNG, the existing event/replay system, the existing Redis
  snapshot/recovery, and the existing socket projection. No `BombPotEngine`, no
  duplicated hand evaluation or side-pot logic.
- Tournaments / PLO / Big O are untouched: `bombPotEnabled` is never set for
  them and the engine rejects `bombPot` for non-Hold'em anyway.
- `PokerHand.bombPotAmount` is recorded per hand (0 on a normal hand) so hand
  history and replay know a hand was a bomb pot.
- The schedule is table-wide, not per-seat: players joining mid-cycle see the
  same `nextInHands` countdown as everyone else.
