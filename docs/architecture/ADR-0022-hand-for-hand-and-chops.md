# ADR-0022: Hand-for-hand play and exact-tie chops

Status: Accepted — 2026-09-05 (Phase 2, follow-up to ADR-0021)

## Context

The multi-table coordinator (ADR-0020) already advances every table in
lockstep - a "round" is one hand at every live table, all finished before any
table starts the next (`afterHand` holds idle tables while another is still
playing). But finishing positions were assigned **eagerly, per table**, the
moment each table's `handComplete` was processed. So which table's socket
delivered its `handComplete` first decided who got the worse place - a
race that mis-orders the money bubble. And exactly-tied bust-outs got
consecutive places by processing order rather than a chop.

## Decisions

### The round, not the hand, is the unit

"Hand-for-hand" here is not "pause everyone whenever a bust happens". It is:
**a round is one hand at every live table; a bust's finishing position is not
assigned until the whole round has closed.** The lockstep already existed
(`afterHand`); this PR moves position assignment to the round boundary.

- `onHandComplete` now only marks a bust _pending_ - it frees the seat and
  zeroes the stack synchronously (so `planBalance` sees the right seating),
  but records nothing more than `stackAtHandStart`.
- `finalizeRound` runs once in `afterHand`, when no table has a hand in
  progress, **before** `planBalance`. It takes every pending bust, orders them
  with the engine's `finishingOrder` (bigger covered stack finishes higher;
  exact ties fall to player id), and assigns the next contiguous block of
  places counting down from `entrants - eliminatedCount`.

Because the order is one deterministic sort over the whole round, the order in
which tables happened to finish - or in which their notifications were
delivered - cannot move the standings. A test drives the tables **in reverse
order** and asserts byte-identical results.

### Hand-for-hand mode + chops

`handForHand` turns on (and stays on) once a round _could_ reach the money:
`enteringField <= paidPlaces + tableCount` (each table can bust at least one).
While it is on, a group of players who busted the same round with **exactly
equal covered stacks** (`bustedTogether`), and whose contiguous place range
reaches a paid place, **chop** that range's combined prize money.

- The split is `floor(combined / groupSize)` each; the odd chips go to the
  better (lower) places first. The combined money is fully redistributed, so
  the total is never changed.
- `computePayouts(entrants, prizePool, chopGroups)` is the pure function that
  applies this on top of `payoutSchedule`.
- Chops before the bubble are pointless (nobody's paid) so they are skipped -
  ties there are just broken deterministically by `finishingOrder`.

The tricky maths (`assignRoundPositions`, `computePayouts`) live in a pure
module, `apps/api/src/tournaments/standings.ts`, tested exhaustively.

### Hard invariants

`checkStandings` runs after `finalizeRound` and after the winner is set:
distinct places, all in `[1, entrants]`, eliminated places form a contiguous
block from `entrants` downward. `maybeFinish` computes the whole payout table
and **verifies `sum == prizePool` before moving a single chip**, so a
standings/chop bug can never half-pay a tournament - it throws (loud), the
run stalls for a human, and in tests the throw fails the test.

## Files changed

- `apps/api/src/tournaments/standings.ts` (new) - `assignRoundPositions`,
  `computePayouts`
- `apps/api/src/tournaments/tournament-runner.ts` - `pendingBust` on the
  entry, `finalizeRound`, `handForHand`, `checkStandings`, chop-aware
  `maybeFinish`, `onOrchestrationError`
- `apps/api/src/tournaments/standings.spec.ts` (new)
- `apps/api/src/tournaments/tournament-runner.spec.ts` - adversarial cases;
  ladder assertions relaxed to the invariants where jam-bots legitimately
  produce ties

## Hand-for-hand algorithm

```
onHandComplete(table, n):
  for each bust b in n.busted:
    entry.pendingBust = { stackAtHandStart: b.stackAtHandStart }
    entry.stack = 0; free the seat            # synchronous, before any await

afterHand():                                  # one per table notification
  if any table has a hand in progress:
    hold every idle table; return             # lockstep - laggard releases all
  finalizeRound()                             # <-- the round boundary
  runBalance()                                # planBalance, breaks, moves
  maybeFinish()

finalizeRound():
  pending = entries with pendingBust and no finishPosition
  if none: return
  roundNumber += 1
  if not handForHand and enteringField <= paidPlaces + tableCount:
    handForHand = true
  { positions, chopGroups } = assignRoundPositions(pending, eliminatedCount,
                                                   entrants, roundNumber,
                                                   handForHand, paidPlaces)
  apply positions; clear pendingBust; publish `eliminated`
  eliminatedCount += positions.size
  checkStandings()
```

## Chop algorithm

```
assignRoundPositions:
  order = finishingOrder(pending as Eliminations, [])   # best finish first
  place order[i] at (entrants - eliminatedCount - k + 1 + i)   # contiguous block
  if handForHand:
    walk `order`; a maximal run of consecutive entries that are all
    bustedTogether() is a tie group; if its best place <= paidPlaces,
    push its place range as a chop group

computePayouts(entrants, prizePool, chopGroups):
  out[pos] = payoutSchedule(entrants, prizePool)[pos-1]  or 0 past the ladder
  for each chop group:
    combined = sum(out[pos] for pos in group)
    each = floor(combined / size); remainder to the lowest places first
  return out                                            # sum unchanged == pool
```

## New invariants (asserted in code and tests)

1. Every eliminated player gets exactly one finishing position.
2. No finishing position is assigned twice; none out of `[1, entrants]`.
3. Eliminated places form one contiguous block from `entrants` downward.
4. `sum(payouts) == prizePool` - verified before any chip moves.
5. Payouts never increase down the standings.
6. Everything past `paidPlaces` (allowing one bubble-chop rung) pays 0.
7. Standings are deterministic under identical inputs (same seed -> identical
   `resultsJson`, twice).
8. Table-completion order cannot reorder the standings (forward vs reverse
   driving -> identical `resultsJson`).

## Tests added

**`standings.spec.ts` (18):**

- lone bust takes the worst open place; non-tied simultaneous busts order by
  covered stack, no chop; deterministic regardless of report order;
  contiguous descending block
- 2-way tie straddling the payout boundary chops places 3 & 4; a tie entirely
  out of the money is not a chop; a 3-way tie whose best place is unpaid is
  not a chop; a 3-way tie reaching a paid place chops the whole range; two
  separate tie groups in one round; only the paid tie group chops;
  hand-for-hand off -> no chop; small fields (6/7/8, one paid)
- `computePayouts`: no chop -> exact ladder; bubble chop [3,4]; chop across
  two paid rungs [2,3]; 3-way chop [3,4,5] with odd-chip placement; odd-size
  combined pots lose nothing; the total equals the pool for arbitrary chop
  shapes across many fields

**`tournament-runner.spec.ts` (+4):**

- fully deterministic: same seed -> byte-identical standings twice
- table-completion order never moves the standings (forward vs reverse)
- a multi-table field fills exactly one contiguous place set and pays the
  pool; heads-up and the final table are both observed
- an eliminated player has exactly one position, no position used twice,
  checked hand by hand through a 12-player run

## Test results

API unit **96** (+22: 18 standings + 4 coordinator). API e2e **51** (9 suites,
unchanged count - the gateway spec's elimination assertions still hold, they
now fire at the round boundary with the correct place). Engine 366, mobile 60.
typecheck / lint / format / build green.

## Remaining edge cases

- With all-in jam bots, an entire round can bust dozens of players who all
  started with exactly `startingStack` - a genuine mass exact-tie. If that
  round is in hand-for-hand and reaches the money, they chop that money N
  ways. It is rules-correct (they were exactly equal) and the total is
  conserved, but it is not what a human expects; real play (varied stacks,
  hand-for-hand only at the bubble) never produces it. The big-field tests
  assert the invariants, not a clean ladder.
- Hand-for-hand starts one round early (`paidPlaces + tableCount`) rather than
  exactly at `paidPlaces + 1`, to be safe against a round that busts several
  players across tables and jumps the bubble.
- A chop can pull the bubble place (`paidPlaces + 1`) into the money for a
  half-share; `paid` counts can therefore be `placesPaid` or `placesPaid + 1`.

## Next

Tournament clock + registration/lobby screens (#3), then antes, restart
recovery, and a deployed bot soak.
