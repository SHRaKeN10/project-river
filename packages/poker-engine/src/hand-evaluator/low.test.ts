import { parseCards } from '../cards';
import { compareLowRanks, describeLow, evaluateLow } from './low';

const hole = (s: string) => parseCards(s);
const board = (s: string) => parseCards(s);

/** Big O: exactly 2 of 5 hole cards + 3 of 5 board, eight-or-better. */
const low = (h: string, b: string) => evaluateLow(hole(h), board(b), 2, 8);

describe('evaluateLow', () => {
  it('finds the wheel as the nut low across every 2+3 split', () => {
    // A-5 (hole) + 3-4-2 (board) is the wheel; A-2 + 3-4-8 also qualifies but is worse.
    const rank = low('Ah 2c 5h 9d Ks', '3d 4s 8c Qh 2s');
    expect(rank).not.toBeNull();
    expect(rank?.ranks).toEqual([5, 4, 3, 2, 1]);
  });

  it('an eight qualifies, a nine does not', () => {
    // A-2 (hole) + 4-5-8 (board)
    expect(low('Ah 2c 3d Kc Qs', '4s 5h 8c 9d Th')?.ranks).toEqual([8, 5, 4, 2, 1]);
    // only one board card is now <= 8, so no five-card low can be made
    expect(low('Ah 2c 3d Kc Qs', '4s 9h 9c Td Th')).toBeNull();
  });

  it('is null when a five-card board is all high cards', () => {
    expect(low('Ah 2c 3d 4s 5h', 'Kc Qd Jh Ts 9c')).toBeNull();
  });

  it('is null when fewer than two hole cards are low', () => {
    // only the ace is low; any second hole card drags a 9+ into the hand
    expect(low('Ah Kc Qd Jh Ts', '2c 3d 4s 5h 6c')).toBeNull();
  });

  it('needs a five-card board and two hole cards', () => {
    expect(evaluateLow(hole('Ah'), board('2c 3d 4s 5h 6c'), 2, 8)).toBeNull();
    expect(evaluateLow(hole('Ah 2c 3d'), board('4s 5h'), 2, 8)).toBeNull();
  });
});

describe('compareLowRanks', () => {
  const wheel = { ranks: [5, 4, 3, 2, 1] };
  const sixLow = { ranks: [6, 4, 3, 2, 1] };
  const eightLow = { ranks: [8, 6, 4, 2, 1] };

  it('a lower vector is the better low', () => {
    expect(compareLowRanks(wheel, sixLow)).toBeGreaterThan(0);
    expect(compareLowRanks(sixLow, wheel)).toBeLessThan(0);
    expect(compareLowRanks(sixLow, eightLow)).toBeGreaterThan(0);
  });

  it('an identical low is a tie (a quartered pot)', () => {
    expect(compareLowRanks(wheel, { ranks: [5, 4, 3, 2, 1] })).toBe(0);
  });

  it('breaks a tie on the lower second card', () => {
    // 8-6-... beats 8-7-...
    expect(compareLowRanks({ ranks: [8, 6, 5, 4, 1] }, { ranks: [8, 7, 3, 2, 1] })).toBeGreaterThan(
      0,
    );
  });
});

describe('describeLow', () => {
  it('names the ranks with the ace low', () => {
    expect(describeLow({ ranks: [5, 4, 3, 2, 1] })).toBe('5-4-3-2-A low');
    expect(describeLow({ ranks: [8, 6, 4, 2, 1] })).toBe('8-6-4-2-A low');
  });
});
