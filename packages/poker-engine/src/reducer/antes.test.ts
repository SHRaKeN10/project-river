import { betTo, call, check, fold, raiseTo, allIn, type BettingContext } from '../betting';
import { legalActions } from '../action-validator';
import { type GameEvent } from '../events/events';
import { type GameState, Street, totalPot } from '../game-state/game-state';
import { PlayerStatus } from '../player/player';
import { type RandomProvider, SeededRandomProvider } from '../rng/random-provider';
import { createTableConfig, previousPositionsOf } from '../table/table';
import { buildDeck } from '../testkit/deckBuilder';
import { HandRunner, type Seat } from '../testkit/handRunner';
import { type EngineAction, initGameState, reduce } from './reduce';
import { replayHand, type HandRecord } from './replay';

/**
 * Tournament antes through the full reducer. Every player dealt into the hand
 * posts `config.ante` before the blinds; the ante is dead money (it never
 * counts toward a call) but it lands in the right main / side pot, and a short
 * stack the ante empties is all-in.
 */

const cfg = (ante: number) => createTableConfig({ smallBlind: 5, bigBlind: 10, ante });

const seats = (stacks: number[]): Seat[] =>
  stacks.map((stack, i) => ({ userId: `u${i}`, seatNumber: i, stack }));

const types = (events: GameEvent[]): string[] => events.map((e) => e.type);
const antesPosted = (events: GameEvent[]) =>
  events.filter((e): e is Extract<GameEvent, { type: 'ANTE_POSTED' }> => e.type === 'ANTE_POSTED');
const seatOf = (s: GameState, seat: number) => s.players.find((p) => p.seatNumber === seat)!;

// ---------------------------------------------------------------------------
// posting
// ---------------------------------------------------------------------------

describe('ante posting', () => {
  it('every dealt-in player antes before the blinds, and the pot is exact', () => {
    const h = new HandRunner(cfg(10), seats([1000, 1000, 1000]));
    h.startHand();

    // 3 antes of 10, then SB 5 and BB 10
    expect(types(h.events)).toEqual([
      'HAND_STARTED',
      'ANTE_POSTED',
      'ANTE_POSTED',
      'ANTE_POSTED',
      'BLIND_POSTED',
      'BLIND_POSTED',
      'HOLE_CARDS_DEALT',
    ]);
    expect(antesPosted(h.events).map((e) => e.amount)).toEqual([10, 10, 10]);

    // button 0, SB 1, BB 2
    expect(seatOf(h.state, 0)).toMatchObject({ currentBet: 0, totalInvested: 10, stack: 990 });
    expect(seatOf(h.state, 1)).toMatchObject({ currentBet: 5, totalInvested: 15, stack: 985 });
    expect(seatOf(h.state, 2)).toMatchObject({ currentBet: 10, totalInvested: 20, stack: 980 });

    expect(h.state.collectedPot).toBe(30); // the three antes
    expect(totalPot(h.state)).toBe(45); // + SB + BB
    expect(h.chips()).toBe(3000);
  });

  it('the ante is not a voluntary bet - the big blind still owes a full call after everyone antes', () => {
    const h = new HandRunner(cfg(10), seats([1000, 1000, 1000]));
    h.startHand();
    // UTG (button, seat 0) faces the full big blind despite having anted
    expect(h.state.actingSeat).toBe(0);
    const ctx: BettingContext = {
      players: h.state.players,
      round: h.state.round,
      actingSeat: 0,
    };
    const kinds = legalActions(ctx, 0).map((o) => o.kind);
    expect(kinds).toContain('CALL'); // must call the BB, cannot check
    expect(kinds).not.toContain('CHECK');
    expect(h.toCall(0)).toBe(10);
  });

  it('a level with ante 0 posts no antes', () => {
    const h = new HandRunner(cfg(0), seats([1000, 1000]));
    h.startHand();
    expect(types(h.events)).toEqual([
      'HAND_STARTED',
      'BLIND_POSTED',
      'BLIND_POSTED',
      'HOLE_CARDS_DEALT',
    ]);
    expect(antesPosted(h.events)).toHaveLength(0);
  });

  it('a player sitting out (busted last hand) does not ante', () => {
    // seat 2 has just enough to be dealt one hand, then busts.
    const h = new HandRunner(cfg(10), seats([1000, 1000, 25]));
    const order = h.nextDealOrder();
    h.startHand(
      buildDeck({ order, holes: { 0: 'Ah As', 1: 'Kh Kd', 2: '7c 2d' }, board: '3c 8s Tc Jd 4h' }),
    );
    // seat 2 (BB) is short; get it all-in and losing
    h.act(h.state.actingSeat!, allIn()); // seat 0 jams
    h.act(h.state.actingSeat!, fold()); // seat 1 folds
    h.act(h.state.actingSeat!, call()); // seat 2 calls all-in, loses
    h.autoFinish();
    expect(h.state.street).toBe(Street.Complete);
    expect(h.stackOf(2)).toBe(0);

    // next hand: only seats 0 and 1 ante
    h.startHand();
    expect(antesPosted(h.lastEvents)).toHaveLength(2);
    expect(seatOf(h.state, 2).status).toBe(PlayerStatus.SittingOut);
  });
});

// ---------------------------------------------------------------------------
// short stacks / all-in from the ante
// ---------------------------------------------------------------------------

describe('short stacks and the ante', () => {
  it('stack comfortably above the ante and the blind: a normal ante, still active', () => {
    const h = new HandRunner(cfg(10), seats([1000, 1000, 200]));
    h.startHand();
    const bb = seatOf(h.state, 2);
    expect(bb.status).toBe(PlayerStatus.Active);
    expect(bb).toMatchObject({ totalInvested: 20, currentBet: 10, stack: 180 }); // ante + BB
  });

  it('stack exactly equal to the ante: all-in for the ante, posts no blind', () => {
    // seat 2 is the BB with a stack of exactly one ante
    const h = new HandRunner(cfg(10), seats([1000, 1000, 10]));
    h.startHand();
    const bb = seatOf(h.state, 2);
    expect(bb).toMatchObject({ stack: 0, currentBet: 0, totalInvested: 10 });
    expect(bb.status).toBe(PlayerStatus.AllIn);
    // exactly one all-in event for that seat, no BLIND_POSTED for it
    const blinds = h.events.filter((e) => e.type === 'BLIND_POSTED');
    expect(blinds).toHaveLength(1); // only the SB
    const allIns = h.events.filter(
      (e): e is Extract<GameEvent, { type: 'PLAYER_WENT_ALL_IN' }> =>
        e.type === 'PLAYER_WENT_ALL_IN' && e.seat === 2,
    );
    expect(allIns).toHaveLength(1);
    expect(allIns[0]!.amount).toBe(10);
    expect(h.chips()).toBe(2010);
  });

  it('stack smaller than the ante: all-in for a partial ante', () => {
    const h = new HandRunner(cfg(10), seats([1000, 1000, 7]));
    h.startHand();
    const short = seatOf(h.state, 2);
    expect(short).toMatchObject({ stack: 0, totalInvested: 7 });
    expect(short.status).toBe(PlayerStatus.AllIn);
    expect(antesPosted(h.events).find((e) => e.seat === 2)?.amount).toBe(7);
    expect(h.chips()).toBe(2007);
  });

  it('stack exactly ante + small blind: antes, then all-in posting the small blind', () => {
    // put the short stack in the SB seat (3-handed: button 0, SB 1, BB 2)
    const h = new HandRunner(cfg(10), seats([1000, 15, 1000]));
    h.startHand();
    const sb = seatOf(h.state, 1);
    expect(sb).toMatchObject({ stack: 0, currentBet: 5, totalInvested: 15 });
    expect(sb.status).toBe(PlayerStatus.AllIn);
    expect(h.chips()).toBe(2015);
  });

  it('stack between the ante and the big blind: antes, then all-in for a short blind', () => {
    const h = new HandRunner(cfg(10), seats([1000, 1000, 13]));
    h.startHand();
    const bb = seatOf(h.state, 2);
    expect(bb).toMatchObject({ stack: 0, currentBet: 3, totalInvested: 13 });
    expect(bb.status).toBe(PlayerStatus.AllIn);
    // the round still reflects a full big blind - others owe 10, not 3
    expect(h.state.round.currentBet).toBe(10);
    expect(h.toCall(0)).toBe(10);
    expect(h.chips()).toBe(2013);
  });

  it('stack smaller than both the ante and the blind: all-in on the ante, no blind at all', () => {
    const h = new HandRunner(cfg(10), seats([1000, 1000, 3]));
    h.startHand();
    const bb = seatOf(h.state, 2);
    expect(bb).toMatchObject({ stack: 0, currentBet: 0, totalInvested: 3 });
    expect(bb.status).toBe(PlayerStatus.AllIn);
    expect(h.events.filter((e) => e.type === 'BLIND_POSTED')).toHaveLength(1); // SB only
    expect(h.state.round.currentBet).toBe(10);
    expect(h.chips()).toBe(2003);
  });

  it('every player all-in from the ante runs the board out and pays the whole pot', () => {
    const h = new HandRunner(cfg(50), seats([30, 40, 20]));
    const order = h.nextDealOrder();
    h.startHand(
      buildDeck({ order, holes: { 0: 'Ah As', 1: 'Kh Kd', 2: 'Qh Qd' }, board: '2c 7d 9h Js 3s' }),
    );
    // nobody can act - all three are all-in on the ante
    expect(h.state.actingSeat).toBeNull();
    expect(h.state.street).toBe(Street.Complete);
    expect(h.state.players.every((p) => p.status === PlayerStatus.AllIn)).toBe(true);

    // pots: 20x3=60 to seat 0 (AA); 10x2 (seats 0,1) = 20 to seat 0
    expect(h.payoutOf(0)).toBe(80);
    expect(h.stackOf(0)).toBe(80);
    expect(h.stackOf(1)).toBe(10); // 40 - 30 contested
    expect(h.stackOf(2)).toBe(0);
    expect(h.totalStacks()).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// side pots
// ---------------------------------------------------------------------------

describe('antes and side pots', () => {
  it('a short ante-only all-in wins a main pot that includes every ante', () => {
    // seat 0 all-in on the ante alone; seats 1 & 2 play a full hand
    const h = new HandRunner(cfg(10), seats([8, 1000, 1000]));
    const order = h.nextDealOrder();
    h.startHand(
      buildDeck({ order, holes: { 0: 'Ah As', 1: 'Kh Kd', 2: 'Qh Qd' }, board: '2c 5d 9h Js 3c' }),
    );
    // seat 0 is all-in from the ante; action starts with SB (seat 1)
    h.act(h.state.actingSeat!, call()); // SB completes to 10
    h.act(h.state.actingSeat!, check()); // BB checks its option
    // flop / turn / river checked down
    h.autoFinish();

    expect(h.state.street).toBe(Street.Complete);
    // main pot: 8 x 3 = 24 -> seat 0 (AA)
    expect(h.payoutOf(0)).toBe(24);
    // side pot: (20 - 8) x 2 = 24 -> seat 1 (KK), seat 2 not eligible past 8
    expect(h.payoutOf(1)).toBe(24);
    expect(h.payoutOf(2)).toBe(0);
    expect(h.stackOf(0)).toBe(24);
    expect(h.totalStacks()).toBe(2008);
  });

  it('three stack sizes all-in from the ante build three pots, each to its best hand', () => {
    const h = new HandRunner(cfg(20), seats([8, 15, 50, 1000]));
    const order = h.nextDealOrder();
    h.startHand(
      buildDeck({
        order,
        holes: { 0: 'Ah As', 1: 'Kh Kd', 2: 'Qh Qd', 3: '7c 2d' },
        board: '3c 8s Tc Jd 4h',
      }),
    );
    // seats 0,1 all-in on the ante. seat 2 anted 20 (stack 30), seat 3 anted 20.
    // 4-handed first hand: button 0, SB 1, BB 2, UTG 3 acts first.
    h.act(h.state.actingSeat!, call()); // seat 3 calls the BB (10)
    h.act(h.state.actingSeat!, check()); // seat 2 (BB) checks
    h.autoFinish();

    expect(h.state.street).toBe(Street.Complete);
    // contributions: 0->8, 1->15, 2->30, 3->30
    // pot0: 8x4 = 32 -> seat 0 (AA), eligible all
    // pot1: 7x3 = 21 -> seat 1 (KK), eligible {1,2,3}
    // pot2: 15x2 = 30 -> seat 2 (QQ), eligible {2,3}
    expect(h.payoutOf(0)).toBe(32);
    expect(h.payoutOf(1)).toBe(21);
    expect(h.payoutOf(2)).toBe(30);
    expect(h.payoutOf(3)).toBe(0);
    expect(h.stackOf(0)).toBe(32);
    expect(h.stackOf(1)).toBe(21);
    expect(h.stackOf(2)).toBe(50);
    expect(h.stackOf(3)).toBe(970);
    expect(h.totalStacks()).toBe(8 + 15 + 50 + 1000);
  });

  it("a folded player's ante stays in the pot as dead money", () => {
    const h = new HandRunner(cfg(10), seats([1000, 1000, 1000]));
    const order = h.nextDealOrder();
    h.startHand(
      buildDeck({ order, holes: { 0: '7c 2d', 1: 'Ah As', 2: 'Kh Kd' }, board: '3c 8s Tc Jd 4h' }),
    );
    h.act(h.state.actingSeat!, fold()); // seat 0 folds - its 10 ante is dead money
    h.act(h.state.actingSeat!, call()); // SB completes
    h.act(h.state.actingSeat!, check()); // BB checks
    h.autoFinish();

    // the pot seat 1 wins includes seat 0's forfeited ante: 3 antes (30) + SB/BB (20) = 50
    expect(h.payoutOf(1)).toBe(50);
    expect(h.stackOf(0)).toBe(990); // lost exactly the ante
    expect(h.stackOf(1)).toBe(1000 - 20 + 50);
    expect(h.totalStacks()).toBe(3000);
  });

  it('everyone folds to the big blind: the big blind sweeps every ante', () => {
    const h = new HandRunner(cfg(10), seats([1000, 1000, 1000]));
    h.startHand();
    h.act(h.state.actingSeat!, fold()); // seat 0
    h.act(h.state.actingSeat!, fold()); // seat 1 (SB)
    expect(h.state.street).toBe(Street.Complete);
    // BB nets the two other antes + the dead small blind = 25
    expect(h.stackOf(2)).toBe(1025);
    expect(h.stackOf(0)).toBe(990);
    expect(h.stackOf(1)).toBe(985);
    expect(h.totalStacks()).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// dealer / blind interaction
// ---------------------------------------------------------------------------

describe('antes and button / blind rules', () => {
  it('heads-up: the button/SB and the BB each ante then post their blind', () => {
    const h = new HandRunner(cfg(10), seats([1000, 1000]));
    h.startHand();
    // heads-up: seat 0 is button + SB, seat 1 is BB
    expect(seatOf(h.state, 0)).toMatchObject({ totalInvested: 15, currentBet: 5 }); // ante + SB
    expect(seatOf(h.state, 1)).toMatchObject({ totalInvested: 20, currentBet: 10 }); // ante + BB
    expect(h.state.collectedPot).toBe(20);
    expect(h.chips()).toBe(2000);
  });

  it('full 9-handed table: nine antes, then the blinds', () => {
    const h = new HandRunner(cfg(20), seats(Array.from({ length: 9 }, () => 5000)));
    h.startHand();
    expect(antesPosted(h.events)).toHaveLength(9);
    expect(h.state.collectedPot).toBe(180); // 9 x 20
    expect(totalPot(h.state)).toBe(180 + 5 + 10);
    expect(h.chips()).toBe(45_000);
  });

  it('a dead small blind still collects antes from everyone dealt in', () => {
    // seat 1 leaves after hand 1, creating a dead small blind on hand 2
    const h = new HandRunner(cfg(10), seats([1000, 1000, 1000, 1000]));
    h.startHand();
    h.autoFinish(); // hand 1 checks down or folds around
    // remove seat 1 (as a balance move would) by sitting them out
    h.dispatch({ type: 'SIT_OUT', seat: 1 });

    h.startHand();
    // seats 0, 2, 3 are dealt in and ante; seat 1 (sitting out) does not
    expect(antesPosted(h.lastEvents)).toHaveLength(3);
    expect(h.chips()).toBe(4000); // seat 1 keeps its stack on the side
  });
});

// ---------------------------------------------------------------------------
// chip conservation / determinism
// ---------------------------------------------------------------------------

describe('antes: conservation and determinism', () => {
  function randomLegal(state: GameState, rng: RandomProvider): EngineAction {
    const seat = state.actingSeat as number;
    const player = state.players.find((p) => p.seatNumber === seat)!;
    const options = legalActions(
      { players: state.players, round: state.round, actingSeat: seat },
      seat,
    );
    const choice = options[rng.nextInt(options.length)];
    if (!choice) return { type: 'PLAYER_ACTION', seat, action: fold() };
    switch (choice.kind) {
      case 'FOLD':
        return { type: 'PLAYER_ACTION', seat, action: fold() };
      case 'CHECK':
        return { type: 'PLAYER_ACTION', seat, action: check() };
      case 'CALL':
        return { type: 'PLAYER_ACTION', seat, action: call() };
      case 'ALL_IN':
        return { type: 'PLAYER_ACTION', seat, action: allIn() };
      default: {
        const min = choice.min ?? player.currentBet + player.stack;
        const max = choice.max ?? min;
        const amount = min + (max > min ? rng.nextInt(max - min + 1) : 0);
        return {
          type: 'PLAYER_ACTION',
          seat,
          action: choice.kind === 'BET' ? betTo(amount) : raiseTo(amount),
        };
      }
    }
  }

  const chipsInPlay = (s: GameState): number =>
    s.players.reduce((t, p) => t + p.stack + p.currentBet, 0) +
    (s.street === Street.Complete ? 0 : s.collectedPot);

  it('holds chip conservation after every action over thousands of anted hands', () => {
    const rng = new SeededRandomProvider(0xa17e);
    const config = cfg(8);
    let hands = 0;
    let anteAllIns = 0;

    for (let seed = 0; seed < 1500; seed += 1) {
      const count = 2 + (seed % 6);
      const stacks: Record<number, number> = {};
      for (let seat = 0; seat < count; seat += 1) {
        // deliberately include stacks near / below the ante
        stacks[seat] = 1 + rng.nextInt(seed % 11 === 0 ? 20 : 600);
      }
      const total = Object.values(stacks).reduce((a, b) => a + b, 0);
      let state = initGameState({
        tableId: 'ante-sim',
        config,
        players: Object.entries(stacks).map(([seat, stack]) => ({
          userId: `u${seat}`,
          seatNumber: Number(seat),
          stack,
        })),
      });

      let previous = null as null | ReturnType<typeof previousPositionsOf>;
      for (let hand = 1; hand <= 4; hand += 1) {
        if (state.players.filter((p) => p.stack > 0).length < 2) break;
        let res = reduce(
          state,
          { type: 'START_HAND', handId: `h${hand}`, handNumber: hand, previousPositions: previous },
          rng,
        );
        expect(chipsInPlay(res.state)).toBe(total);
        if (res.events.some((e) => e.type === 'ANTE_POSTED')) {
          if (res.events.some((e) => e.type === 'PLAYER_WENT_ALL_IN')) anteAllIns += 1;
        }

        let guard = 0;
        while (res.state.street !== Street.Complete && res.state.actingSeat !== null) {
          res = reduce(res.state, randomLegal(res.state, rng), rng);
          expect(res.events.some((e) => e.type === 'ACTION_REJECTED')).toBe(false);
          expect(chipsInPlay(res.state)).toBe(total);
          for (const p of res.state.players) expect(p.stack).toBeGreaterThanOrEqual(0);
          if ((guard += 1) > 400) throw new Error('hand did not terminate');
        }
        expect(res.state.street).toBe(Street.Complete);
        expect(res.state.players.reduce((t, p) => t + p.stack, 0)).toBe(total);

        // the HAND_COMPLETED nets sum to zero even with antes
        const completed = res.events.find(
          (e): e is Extract<GameEvent, { type: 'HAND_COMPLETED' }> => e.type === 'HAND_COMPLETED',
        )!;
        expect(completed.results.reduce((t, r) => t + r.net, 0)).toBe(0);

        state = res.state;
        previous = previousPositionsOf(state);
        hands += 1;
      }
    }

    expect(hands).toBeGreaterThan(3000);
    expect(anteAllIns).toBeGreaterThan(20); // the short-stack path was exercised
  });

  it('an anted hand replays bit-identically from its record', () => {
    const config = cfg(15);
    const record: HandRecord = {
      tableId: 't',
      config,
      seats: [
        { userId: 'u0', seatNumber: 0, stack: 500 },
        { userId: 'u1', seatNumber: 1, stack: 22 },
        { userId: 'u2', seatNumber: 2, stack: 500 },
      ],
      handId: 'hr1',
      handNumber: 1,
      previousPositions: null,
      deck: buildDeck({
        order: [1, 2, 0],
        holes: { 0: 'Ah As', 1: 'Kh Kd', 2: 'Qh Qd' },
        board: '2c 7d 9h Js 3s',
      }),
      actions: [
        { type: 'PLAYER_ACTION', seat: 0, action: allIn() },
        { type: 'PLAYER_ACTION', seat: 1, action: allIn() },
        { type: 'PLAYER_ACTION', seat: 2, action: allIn() },
      ],
    };

    const a = replayHand(record);
    const b = replayHand(record);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
    expect(a.state.street).toBe(Street.Complete);
    expect(a.state.players.reduce((t, p) => t + p.stack, 0)).toBe(1022);
    // seat 1 (stack 22, ante 15) is short - the ante path is exercised
    expect(a.events.some((e) => e.type === 'ANTE_POSTED')).toBe(true);
    expect(a.state.players.find((p) => p.seatNumber === 0)?.stack).toBe(1022); // AA scoops
  });
});
