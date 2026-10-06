import { diffFlights, snapshotOf, type TableSnap } from './chipFlights';

const snap = (over: Partial<TableSnap> & { seats?: TableSnap['seats'] } = {}): TableSnap => ({
  handId: 'h1',
  pot: 0,
  seats: [
    { seat: 0, bet: 0, stack: 1000 },
    { seat: 1, bet: 0, stack: 1000 },
  ],
  ...over,
});

describe('diffFlights', () => {
  it('animates nothing on the first snapshot', () => {
    expect(diffFlights(null, snap({ pot: 30 }))).toEqual([]);
  });

  it('sends chips from a seat to its bet spot when it bets', () => {
    const prev = snap();
    const next = snap({
      seats: [
        { seat: 0, bet: 50, stack: 950 },
        { seat: 1, bet: 0, stack: 1000 },
      ],
    });
    expect(diffFlights(prev, next)).toEqual([{ kind: 'bet', seat: 0, amount: 50, delay: 0 }]);
  });

  it('only animates the increase when a bet is raised', () => {
    const prev = snap({ seats: [{ seat: 0, bet: 50, stack: 950 }] });
    const next = snap({ seats: [{ seat: 0, bet: 120, stack: 880 }] });
    expect(diffFlights(prev, next)).toEqual([{ kind: 'bet', seat: 0, amount: 70, delay: 0 }]);
  });

  it('animates posted blinds when a new hand starts', () => {
    const prev = snap({ handId: 'h1', seats: [{ seat: 0, bet: 0, stack: 1000 }] });
    const next = snap({ handId: 'h2', seats: [{ seat: 0, bet: 5, stack: 995 }] });
    expect(diffFlights(prev, next)).toEqual([{ kind: 'bet', seat: 0, amount: 5, delay: 0 }]);
  });

  it('collects bets into the pot when the street ends', () => {
    const prev = snap({
      pot: 20,
      seats: [
        { seat: 0, bet: 40, stack: 960 },
        { seat: 1, bet: 40, stack: 960 },
      ],
    });
    const next = snap({
      pot: 100,
      seats: [
        { seat: 0, bet: 0, stack: 960 },
        { seat: 1, bet: 0, stack: 960 },
      ],
    });
    expect(diffFlights(prev, next)).toEqual([
      { kind: 'collect', seat: 0, amount: 40, delay: 0 },
      { kind: 'collect', seat: 1, amount: 40, delay: 0 },
    ]);
  });

  it('pays the pot out to the winner, after the collect', () => {
    const prev = snap({
      pot: 100,
      seats: [
        { seat: 0, bet: 0, stack: 960 },
        { seat: 1, bet: 0, stack: 960 },
      ],
    });
    const next = snap({
      pot: 0,
      seats: [
        { seat: 0, bet: 0, stack: 1060 },
        { seat: 1, bet: 0, stack: 960 },
      ],
    });
    const flights = diffFlights(prev, next);
    expect(flights).toHaveLength(1);
    expect(flights[0]).toMatchObject({ kind: 'award', seat: 0, amount: 100 });
    expect(flights[0]!.delay).toBeGreaterThan(0);
  });

  it('does not treat a stack top-up with no pot as a win', () => {
    const prev = snap({ pot: 0 });
    const next = snap({
      pot: 0,
      seats: [
        { seat: 0, bet: 0, stack: 2000 },
        { seat: 1, bet: 0, stack: 1000 },
      ],
    });
    expect(diffFlights(prev, next)).toEqual([]);
  });

  it('ignores seats that appeared or left, and unchanged tables', () => {
    const prev = snap();
    expect(diffFlights(prev, snap())).toEqual([]);
    expect(diffFlights(prev, snap({ seats: [{ seat: 2, bet: 10, stack: 990 }] }))).toEqual([]);
  });

  it('caps a re-sync at a dozen flights', () => {
    const seats = Array.from({ length: 20 }, (_, i) => ({ seat: i, bet: 0, stack: 100 }));
    const bet = seats.map((s) => ({ ...s, bet: 10, stack: 90 }));
    expect(diffFlights(snap({ seats }), snap({ seats: bet }))).toHaveLength(12);
  });
});

describe('snapshotOf', () => {
  it('keeps only occupied seats', () => {
    const view = {
      handId: 'h',
      pot: 5,
      seats: [
        { seatNumber: 0, userId: 'u', currentBet: 5, stack: 95 },
        { seatNumber: 1, userId: null, currentBet: 0, stack: 0 },
      ],
    } as never;
    expect(snapshotOf(view)).toEqual({
      handId: 'h',
      pot: 5,
      seats: [{ seat: 0, bet: 5, stack: 95 }],
    });
  });
});
