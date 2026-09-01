/**
 * Minimal ambient types for `pokersolver` (MIT licensed), used ONLY as an
 * independent oracle in tests - never imported by engine source. See
 * oracle.test.ts and docs/architecture/ADR-0003.
 */
declare module 'pokersolver' {
  export class Hand {
    name: string;
    descr: string;
    rank: number;
    static solve(cards: string[]): Hand;
    static winners(hands: Hand[]): Hand[];
  }
}
