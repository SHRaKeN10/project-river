import { type Card, cardId, parseCard, parseCards } from '../cards';
import { createDeck } from '../deck';

export interface DeckSpec {
  /** Seats in the exact order `dealHoleCards` deals them (SB first, clockwise). */
  order: number[];
  /** "As Kd" etc. per seat. */
  holes: Record<number, string>;
  /** Exactly five community cards, "flop flop flop turn river". */
  board: string;
  /** Optional explicit burn cards (flop, turn, river). Defaults are filler. */
  burns?: string;
  /** Hole cards per seat: 2 for Hold'em (default), 4 for Omaha. */
  holeCount?: number;
}

/**
 * Builds a full 52-card deal order so that, once the hand runs, each seat gets
 * the requested hole cards and the board comes out as specified. Remaining
 * positions are filled with the rest of the deck. For deterministic engine
 * tests only.
 */
export function buildDeck(spec: DeckSpec): Card[] {
  const holeCards = new Map<number, Card[]>(
    Object.entries(spec.holes).map(([seat, notation]) => [Number(seat), parseCards(notation)]),
  );
  const board = parseCards(spec.board);
  const burns = spec.burns ? parseCards(spec.burns) : [];
  if (board.length !== 5) throw new Error('board must be exactly 5 cards');

  const deck: (Card | null)[] = new Array(52).fill(null);
  const n = spec.order.length;
  const holeCount = spec.holeCount ?? 2;

  // hole cards: `holeCount` passes over the deal order, matching a real deal
  spec.order.forEach((seat, seatIndex) => {
    const cards = holeCards.get(seat);
    if (!cards || cards.length !== holeCount) {
      throw new Error(`seat ${seat} needs exactly ${holeCount} hole cards`);
    }
    for (let pass = 0; pass < holeCount; pass += 1) {
      deck[pass * n + seatIndex] = cards[pass] as Card;
    }
  });

  let pos = holeCount * n;
  const placeBurn = () => {
    deck[pos] = burns.shift() ?? null; // null -> filled from remainder below
    pos += 1;
  };
  placeBurn();
  deck[pos] = board[0] as Card;
  deck[pos + 1] = board[1] as Card;
  deck[pos + 2] = board[2] as Card;
  pos += 3;
  placeBurn();
  deck[pos] = board[3] as Card;
  pos += 1;
  placeBurn();
  deck[pos] = board[4] as Card;
  pos += 1;

  // fill every remaining slot with unused cards
  const used = new Set(deck.filter((c): c is Card => c !== null).map(cardId));
  const remainder = createDeck().filter((c) => !used.has(cardId(c)));
  for (let i = 0; i < 52; i += 1) {
    if (deck[i] === null) {
      const next = remainder.shift();
      if (!next) throw new Error('ran out of filler cards - duplicate specified card?');
      deck[i] = next;
    }
  }

  return deck.map((c) => {
    if (!c) throw new Error('unfilled deck slot');
    return c;
  });
}

export const c = parseCard;
