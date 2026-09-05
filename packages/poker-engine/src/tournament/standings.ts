/**
 * One player leaving the tournament. `stackAtHandStart` is the tiebreak when
 * two or more players bust in the *same* hand: the player who started that hand
 * with more chips finishes higher (you outlast anyone you had covered). When
 * the covered stacks are exactly equal the two places' prize money is chopped -
 * that is the application's job (see `bustedTogether`); `finishingOrder` still
 * needs a total order, so it falls back to player id.
 */
export interface Elimination {
  readonly playerId: string;
  /** Chips this player had at the start of the hand they busted in. */
  readonly stackAtHandStart: number;
  /** Monotonic across the whole tournament - orders busts between hands. */
  readonly handNumber: number;
}

/** Deterministic total order on eliminations, best finish first. */
function byFinish(a: Elimination, b: Elimination): number {
  if (a.handNumber !== b.handNumber) return b.handNumber - a.handNumber; // later bust = better place
  if (a.stackAtHandStart !== b.stackAtHandStart) {
    return b.stackAtHandStart - a.stackAtHandStart; // bigger covered stack = better place
  }
  return a.playerId < b.playerId ? -1 : 1;
}

/**
 * Finishing positions, best first: `survivors` (the last player standing, or
 * players still in), then eliminations from most recent to first.
 */
export function finishingOrder(
  eliminations: readonly Elimination[],
  survivors: readonly string[],
): string[] {
  return [...survivors, ...[...eliminations].sort(byFinish).map((e) => e.playerId)];
}

/** Two players who busted in the same hand with exactly equal chips share the
 * two places' combined prize money. */
export function bustedTogether(a: Elimination, b: Elimination): boolean {
  return a.handNumber === b.handNumber && a.stackAtHandStart === b.stackAtHandStart;
}
