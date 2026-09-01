import { call, check, fold, raiseTo, allIn } from '../betting';
import { type GameEvent } from '../events/events';
import { type GameState, Street } from '../game-state/game-state';
import { SeededRandomProvider } from '../rng/random-provider';
import { createTableConfig, previousPositionsOf, type PreviousPositions } from '../table/table';
import { type EngineAction, initGameState, reduce } from './reduce';

const config = createTableConfig({ smallBlind: 10, bigBlind: 20 });
const rng = () => new SeededRandomProvider(42);

const table = (stacks: Record<number, number>): GameState =>
  initGameState({
    tableId: 't1',
    config,
    players: Object.entries(stacks).map(([seat, stack]) => ({
      userId: `u${seat}`,
      seatNumber: Number(seat),
      stack,
    })),
  });

/** Total chips in the system - must never change during or after a hand. */
const chips = (s: GameState): number =>
  s.players.reduce((t, p) => t + p.stack + p.currentBet, 0) +
  (s.street === Street.Complete ? 0 : s.collectedPot);

interface Session {
  state: GameState;
  events: GameEvent[];
}

const start = (state: GameState, previousPositions: PreviousPositions | null = null): Session => {
  const res = reduce(
    state,
    { type: 'START_HAND', handId: 'h1', handNumber: 1, previousPositions },
    rng(),
  );
  return { state: res.state, events: res.events };
};

const act = (session: Session, action: EngineAction): Session => {
  const res = reduce(session.state, action, rng());
  return { state: res.state, events: [...session.events, ...res.events] };
};

const types = (events: GameEvent[]) => events.map((e) => e.type);
const seatOf = (s: GameState, seat: number) => s.players.find((p) => p.seatNumber === seat)!;

describe('reduce: START_HAND', () => {
  it('posts blinds, deals hole cards, and sets the first actor (heads-up)', () => {
    const { state, events } = start(table({ 1: 1000, 2: 1000 }));
    expect(state.street).toBe(Street.Preflop);
    expect(state.buttonSeat).toBe(1);
    expect(state.smallBlindSeat).toBe(1); // heads-up: button = SB
    expect(state.bigBlindSeat).toBe(2);
    expect(seatOf(state, 1).currentBet).toBe(10);
    expect(seatOf(state, 2).currentBet).toBe(20);
    expect(seatOf(state, 1).holeCards).toHaveLength(2);
    expect(state.actingSeat).toBe(1); // SB/button acts first pre-flop heads-up
    expect(types(events)).toEqual([
      'HAND_STARTED',
      'BLIND_POSTED',
      'BLIND_POSTED',
      'HOLE_CARDS_DEALT',
    ]);
    expect(chips(state)).toBe(2000);
  });

  it('refuses to start without two funded players', () => {
    const res = reduce(
      table({ 1: 1000 }),
      { type: 'START_HAND', handId: 'h', handNumber: 1, previousPositions: null },
      rng(),
    );
    expect(res.state.street).toBe(Street.Waiting);
    expect(res.events).toHaveLength(0);
  });

  it('rotates the button on the next hand', () => {
    let s = start(table({ 1: 1000, 2: 1000, 3: 1000 }));
    s = act(s, { type: 'PLAYER_ACTION', seat: 1, action: fold() }); // UTG=button folds
    s = act(s, { type: 'PLAYER_ACTION', seat: 2, action: fold() }); // SB folds -> BB wins
    expect(s.state.street).toBe(Street.Complete);

    const next = reduce(
      s.state,
      {
        type: 'START_HAND',
        handId: 'h2',
        handNumber: 2,
        previousPositions: previousPositionsOf(s.state),
      },
      rng(),
    );
    expect(next.state.buttonSeat).toBe(2);
  });
});

describe('reduce: folding', () => {
  it('awards the pot immediately when everyone folds', () => {
    let s = start(table({ 1: 1000, 2: 1000 }));
    s = act(s, { type: 'PLAYER_ACTION', seat: 1, action: fold() }); // button/SB folds pre-flop
    expect(s.state.street).toBe(Street.Complete);
    expect(seatOf(s.state, 2).stack).toBe(1010); // won the 10 SB
    expect(seatOf(s.state, 1).stack).toBe(990);
    expect(types(s.events)).toContain('POT_AWARDED');
    expect(types(s.events)).toContain('HAND_COMPLETED');
    expect(chips(s.state)).toBe(2000);
  });

  it('rejects an out-of-turn action without changing state', () => {
    const s = start(table({ 1: 1000, 2: 1000 }));
    const res = reduce(s.state, { type: 'PLAYER_ACTION', seat: 2, action: check() }, rng());
    expect(res.events).toEqual([expect.objectContaining({ type: 'ACTION_REJECTED', seat: 2 })]);
    expect(res.state).toBe(s.state);
  });

  it('rejects an illegal action (check facing a bet)', () => {
    const s = start(table({ 1: 1000, 2: 1000 }));
    const res = reduce(s.state, { type: 'PLAYER_ACTION', seat: 1, action: check() }, rng());
    expect(res.events[0]?.type).toBe('ACTION_REJECTED');
  });
});

describe('reduce: full hands', () => {
  it('plays a limped, checked-down hand to showdown', () => {
    let s = start(table({ 1: 1000, 2: 1000, 3: 1000 }));
    // pre-flop: UTG(1) call, SB(2) call, BB(3) check
    s = act(s, { type: 'PLAYER_ACTION', seat: 1, action: call() });
    s = act(s, { type: 'PLAYER_ACTION', seat: 2, action: call() });
    s = act(s, { type: 'PLAYER_ACTION', seat: 3, action: check() });
    expect(s.state.street).toBe(Street.Flop);
    expect(s.state.communityCards).toHaveLength(3);

    // flop, turn, river: everyone checks around
    for (const street of [Street.Flop, Street.Turn, Street.River]) {
      expect(s.state.street).toBe(street);
      s = act(s, { type: 'PLAYER_ACTION', seat: s.state.actingSeat!, action: check() });
      s = act(s, { type: 'PLAYER_ACTION', seat: s.state.actingSeat!, action: check() });
      s = act(s, { type: 'PLAYER_ACTION', seat: s.state.actingSeat!, action: check() });
    }

    expect(s.state.street).toBe(Street.Complete);
    expect(types(s.events)).toEqual(
      expect.arrayContaining([
        'SHOWDOWN_STARTED',
        'HAND_REVEALED',
        'POT_AWARDED',
        'HAND_COMPLETED',
      ]),
    );
    expect(s.state.communityCards).toHaveLength(5);
    expect(chips(s.state)).toBe(3000);
    // pot was 60, one winner (or split) — total unchanged
    expect(s.state.players.reduce((t, p) => t + p.stack, 0)).toBe(3000);
  });

  it('runs the board out when all players are all-in pre-flop', () => {
    let s = start(table({ 1: 200, 2: 200 }));
    s = act(s, { type: 'PLAYER_ACTION', seat: 1, action: allIn() }); // SB shoves 200
    s = act(s, { type: 'PLAYER_ACTION', seat: 2, action: call() }); // BB calls all-in
    expect(s.state.street).toBe(Street.Complete);
    expect(s.state.communityCards).toHaveLength(5);
    expect(types(s.events)).toEqual(
      expect.arrayContaining([
        'FLOP_DEALT',
        'TURN_DEALT',
        'RIVER_DEALT',
        'SHOWDOWN_STARTED',
        'HAND_COMPLETED',
      ]),
    );
    expect(s.state.players.reduce((t, p) => t + p.stack, 0)).toBe(400);
    // exactly one side of the 400 (or a 200/200 split)
    const stacks = s.state.players.map((p) => p.stack).sort((a, b) => a - b);
    expect([
      [0, 400],
      [200, 200],
    ]).toContainEqual(stacks);
  });

  it('builds a side pot when a short stack is all-in', () => {
    let s = start(table({ 1: 1000, 2: 1000, 3: 80 }));
    // pre-flop. Order: UTG=1, then SB=2, then BB=3
    s = act(s, { type: 'PLAYER_ACTION', seat: 1, action: raiseTo(200) });
    s = act(s, { type: 'PLAYER_ACTION', seat: 2, action: call() }); // SB calls 200
    s = act(s, { type: 'PLAYER_ACTION', seat: 3, action: allIn() }); // BB all-in for 80 total
    // seats 1 & 2 already matched 200; BB all-in short -> betting round complete
    expect(s.state.street).not.toBe(Street.Preflop);

    // run remaining streets: 1 and 2 check everything
    while (s.state.street !== Street.Complete) {
      s = act(s, { type: 'PLAYER_ACTION', seat: s.state.actingSeat!, action: check() });
    }

    const potAwards = s.events.filter((e) => e.type === 'POT_AWARDED');
    expect(potAwards.length).toBeGreaterThanOrEqual(2); // main + side
    expect(s.state.players.reduce((t, p) => t + p.stack, 0)).toBe(2080);
    expect(chips(s.state)).toBe(2080);
  });

  it('returns an uncalled all-in overbet at the street transition', () => {
    let s = start(table({ 1: 1000, 2: 120 }));
    // heads-up. SB(1) raises to 400, BB(2) all-in for 120 -> 280 of SB's bet is uncalled
    s = act(s, { type: 'PLAYER_ACTION', seat: 1, action: raiseTo(400) });
    s = act(s, { type: 'PLAYER_ACTION', seat: 2, action: allIn() });
    expect(types(s.events)).toContain('BET_RETURNED');
    const returned = s.events.find((e) => e.type === 'BET_RETURNED');
    expect(returned).toMatchObject({ seat: 1, amount: 280 });
    expect(s.state.street).toBe(Street.Complete);
    expect(s.state.players.reduce((t, p) => t + p.stack, 0)).toBe(1120);
  });
});

describe('reduce: TIMEOUT', () => {
  it('auto-checks when the player owes nothing', () => {
    let s = start(table({ 1: 1000, 2: 1000 }));
    s = act(s, { type: 'PLAYER_ACTION', seat: 1, action: call() }); // SB completes
    // BB(2) to act facing no bet
    s = act(s, { type: 'TIMEOUT', seat: 2 });
    expect(types(s.events)).toContain('ACTION_TIMED_OUT');
    expect(types(s.events)).toContain('PLAYER_CHECKED');
    expect(s.state.street).toBe(Street.Flop);
  });

  it('auto-folds when the player faces a bet', () => {
    let s = start(table({ 1: 1000, 2: 1000 }));
    s = act(s, { type: 'PLAYER_ACTION', seat: 1, action: raiseTo(60) });
    s = act(s, { type: 'TIMEOUT', seat: 2 });
    expect(types(s.events)).toContain('PLAYER_FOLDED');
    expect(s.state.street).toBe(Street.Complete);
    expect(seatOf(s.state, 1).stack).toBe(1020);
  });
});

describe('reduce: chip conservation on a scripted 4-player hand', () => {
  it('keeps the chip total exact through every action', () => {
    let s = start(table({ 1: 500, 2: 1500, 3: 800, 4: 2000 }));
    const total = chips(s.state);

    const script: EngineAction[] = [
      { type: 'PLAYER_ACTION', seat: 4, action: raiseTo(60) }, // UTG
      { type: 'PLAYER_ACTION', seat: 1, action: call() }, // BTN
      { type: 'PLAYER_ACTION', seat: 2, action: call() }, // SB
      { type: 'PLAYER_ACTION', seat: 3, action: raiseTo(180) }, // BB 3-bets
      { type: 'PLAYER_ACTION', seat: 4, action: call() },
      { type: 'PLAYER_ACTION', seat: 1, action: fold() },
      { type: 'PLAYER_ACTION', seat: 2, action: allIn() }, // SB jams 1500
      { type: 'PLAYER_ACTION', seat: 3, action: allIn() }, // BB jams 800
      { type: 'PLAYER_ACTION', seat: 4, action: call() },
    ];

    for (const action of script) {
      if (s.state.street === Street.Complete) break;
      s = act(s, action);
      expect(chips(s.state)).toBe(total);
    }
    // finish any remaining check-downs
    while (s.state.street !== Street.Complete && s.state.actingSeat !== null) {
      s = act(s, { type: 'PLAYER_ACTION', seat: s.state.actingSeat, action: check() });
      expect(chips(s.state)).toBe(total);
    }

    expect(s.state.street).toBe(Street.Complete);
    expect(s.state.players.reduce((t, p) => t + p.stack, 0)).toBe(total);
  });
});
