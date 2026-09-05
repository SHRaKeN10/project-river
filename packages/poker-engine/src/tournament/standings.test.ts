import { bustedTogether, type Elimination, finishingOrder } from './standings';

const bust = (playerId: string, handNumber: number, stackAtHandStart: number): Elimination => ({
  playerId,
  handNumber,
  stackAtHandStart,
});

describe('finishingOrder', () => {
  it('the survivor is first, then busts newest to oldest', () => {
    const order = finishingOrder([bust('c', 1, 500), bust('b', 5, 900), bust('d', 3, 200)], ['a']);
    expect(order).toEqual(['a', 'b', 'd', 'c']);
  });

  it('in a same-hand double bust the bigger covered stack finishes higher', () => {
    const order = finishingOrder([bust('x', 9, 300), bust('y', 9, 1200)], ['w']);
    expect(order).toEqual(['w', 'y', 'x']);
  });

  it('equal chips in the same hand fall back to a deterministic order', () => {
    const a = finishingOrder([bust('m', 4, 400), bust('k', 4, 400)], ['z']);
    const b = finishingOrder([bust('k', 4, 400), bust('m', 4, 400)], ['z']);
    expect(a).toEqual(b);
    expect(a).toEqual(['z', 'k', 'm']);
  });
});

describe('bustedTogether', () => {
  it('true only when the hand and covered stack match exactly', () => {
    expect(bustedTogether(bust('a', 4, 400), bust('b', 4, 400))).toBe(true);
    expect(bustedTogether(bust('a', 4, 400), bust('b', 4, 401))).toBe(false);
    expect(bustedTogether(bust('a', 4, 400), bust('b', 5, 400))).toBe(false);
  });
});
