# ADR-0015: Big O — five-card Omaha, eight-or-better hi/lo split

Status: Accepted — 2026-09-05 (Phase 2, follow-up to ADR-0013 / ADR-0014)

## Context

The third and hardest game in the Phase 2 menu: five-card Pot-Limit Omaha
hi/lo. The high side is the Omaha rule the engine already has (best two hole +
three board). The new work is the **low**: a separate eight-or-better hand, and
splitting every pot between the best high and the best qualifying low - with
quartering, odd chips, and scoops - without disturbing the settlement path every
non-hi/lo game uses. As before, **Hold'em and PLO are byte-identical** after this
change; every one of the 304 prior engine tests passes untouched.

## Decisions

### `GameVariant.Omaha5HiLo`

`VariantRules` gains `hiLo` and `lowQualifier`:

| rule            | Hold'em    | Omaha       | Big O       |
| --------------- | ---------- | ----------- | ----------- |
| `holeCards`     | 2          | 4           | 5           |
| `holeCardsUsed` | `null`     | `2`         | `2`         |
| `bettingLimit`  | `NO_LIMIT` | `POT_LIMIT` | `POT_LIMIT` |
| `hiLo`          | `false`    | `false`     | `true`      |
| `lowQualifier`  | `null`     | `null`      | `8`         |

Five hole cards + three burns + a five-card board is 53 cards nine-handed, so
Big O only fits eight. `maxSeatsForVariant(variant)` caps it; `createTableConfig`
defaults `maxSeats` to that cap, and `validateTableConfig` rejects an explicit
`maxSeats` above it. Hold'em / PLO are unaffected (their cap is 9).

### The low evaluator

`hand-evaluator/low.ts`:

- `LowRank` is just five distinct low-card ranks (ace = 1), sorted descending.
  Straights and flushes never count against a low, so only ranks matter.
- `evaluateLow(hole, board, holeCardsUsed, qualifier)` takes the best of every
  `C(5,2) × C(5,3)` split (the two low hole cards need not be the two used for
  the high), or `null` when no five-card combination is five distinct ranks all
  at or below the qualifier.
- `compareLowRanks(a, b)` matches `compareHandRanks` semantics: `> 0` means `a`
  is the **better** (lower) low. `A-2-3-4-5` is the nut low.

`showdown.ts` gains `evaluateLowShowdown(state)` - the qualifying low for every
contesting seat that has one, and an **empty map for every non-hi/lo variant**,
so callers treat "no entry" as "no low".

### Split settlement

`pot-manager.awardPotsHiLo(pots, hiBySeat, loBySeat, oddChipOrder)`:

- No eligible qualifying low → the high hand takes the whole pot (identical to
  `awardPots`).
- Otherwise the low half is `floor(pot / 2)` and the high half is the rest, so
  **the odd chip in the pot goes to the high hand**. Odd chips _within_ a side
  follow `oddChipOrder`. A quartered low is just the low half split among the
  tied low winners; a scoop is the same seat appearing in both lists.

`settleByShowdown` branches on `rules.hiLo`. The muck loop now also tracks each
seat's revealed low and reveals a hand that can win **either** the high or a
qualifying low for any eligible pot (a `beatsOrTiesShown` helper does the
generic "≥ the best shown" check for both). For a hi/lo split the reducer emits
one `POT_AWARDED` per side, tagged `portion: 'HIGH' | 'LOW'`; a whole-pot award
(every non-hi/lo game, and a hi/lo pot with no low) carries no `portion`, as
before. `HAND_REVEALED` gains an optional `low` summary.

### Not in this change

The API and mobile app still open every table as Hold'em or PLO. Wiring
`PokerGameType.OMAHA5_HILO`, the five-card seat UI, the hi/lo winner labels, and
a seeded Big O table is the follow-up integration PR.

## Tests

- `hand-evaluator/low.test.ts` — the wheel is the nut low; an eight qualifies, a
  nine does not; `null` when the board can't supply a low or fewer than two hole
  cards are low; `compareLowRanks` ordering, ties, tie-breaking.
- `pot-manager/pot-manager-hilo.test.ts` — whole pot when no low; the odd chip to
  the high side; scoop; quartered low; odd chips inside a side by order; main +
  side pot conservation.
- `reducer/big-o.test.ts` — five hole cards + the eight-seat cap; a genuine
  hi/lo split; a straight-flush-plus-wheel scoop; whole pot to the high on an
  all-high board; a quartered low with the odd chip to the correct seat.
- `reducer/big-o-simulation.test.ts` — thousands of random Big O hands: no
  illegal action, chips conserved after every action, and for every completed
  hand each `POT_AWARDED.amount` equals what it paid, every `LOW` award is
  exactly the floor half of its pot, and the split path is exercised.

## Result

Engine: **35 suites / 325 tests**. API unit 51, API e2e 35, mobile 51 - all
unchanged, confirming the Hold'em and PLO settlement paths are untouched.
