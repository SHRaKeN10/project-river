import {
  canAct,
  commitChips,
  createPlayer,
  foldPlayer,
  isInHand,
  markActed,
  PlayerActionType,
  PlayerStatus,
  postAnte,
  resetForHand,
  resetForStreet,
} from './player';

const active = (stack: number) => ({ ...createPlayer('u', 3, stack), status: PlayerStatus.Active });

describe('player', () => {
  it('createPlayer starts waiting with a clean slate', () => {
    const p = createPlayer('user-1', 5, 1000);
    expect(p).toMatchObject({
      userId: 'user-1',
      seatNumber: 5,
      stack: 1000,
      currentBet: 0,
      totalInvested: 0,
      status: PlayerStatus.Waiting,
      hasActed: false,
    });
  });

  it('rejects a negative or fractional stack', () => {
    expect(() => createPlayer('u', 1, -1)).toThrow();
    expect(() => createPlayer('u', 1, 10.5)).toThrow();
  });

  describe('commitChips', () => {
    it('moves chips from stack to currentBet and totalInvested', () => {
      const { player, committed } = commitChips(active(1000), 200);
      expect(committed).toBe(200);
      expect(player).toMatchObject({ stack: 800, currentBet: 200, totalInvested: 200 });
      expect(player.status).toBe(PlayerStatus.Active);
    });

    it('caps at the stack and marks all-in', () => {
      const { player, committed } = commitChips(active(150), 400);
      expect(committed).toBe(150);
      expect(player).toMatchObject({ stack: 0, currentBet: 150, status: PlayerStatus.AllIn });
    });

    it('accumulates across multiple commits in a street', () => {
      const first = commitChips(active(1000), 100).player;
      const second = commitChips(first, 250).player;
      expect(second).toMatchObject({ stack: 650, currentBet: 350, totalInvested: 350 });
    });

    it('does not flip a waiting player to all-in', () => {
      const { player } = commitChips(createPlayer('u', 1, 50), 50);
      expect(player.status).toBe(PlayerStatus.Waiting);
    });
  });

  describe('postAnte', () => {
    it('moves chips to totalInvested only - never currentBet', () => {
      const { player, committed } = postAnte(active(1000), 25);
      expect(committed).toBe(25);
      expect(player).toMatchObject({
        stack: 975,
        currentBet: 0,
        totalInvested: 25,
        status: PlayerStatus.Active,
        lastAction: PlayerActionType.PostAnte,
      });
    });

    it('caps at the stack and goes all-in when the ante is short', () => {
      const { player, committed } = postAnte(active(15), 25);
      expect(committed).toBe(15);
      expect(player).toMatchObject({ stack: 0, currentBet: 0, totalInvested: 15 });
      expect(player.status).toBe(PlayerStatus.AllIn);
    });

    it('an ante exactly equal to the stack is all-in', () => {
      const { player, committed } = postAnte(active(25), 25);
      expect(committed).toBe(25);
      expect(player.status).toBe(PlayerStatus.AllIn);
      expect(player.stack).toBe(0);
    });

    it('does not flip a non-in-hand player to all-in', () => {
      const { player } = postAnte(createPlayer('u', 1, 25), 25);
      expect(player.status).toBe(PlayerStatus.Waiting);
    });

    it('a zero ante is a no-op that keeps the prior lastAction', () => {
      const { player, committed } = postAnte(active(1000), 0);
      expect(committed).toBe(0);
      expect(player).toMatchObject({ stack: 1000, totalInvested: 0, lastAction: null });
    });

    it('rejects a negative or fractional ante', () => {
      expect(() => postAnte(active(1000), -1)).toThrow();
      expect(() => postAnte(active(1000), 5.5)).toThrow();
    });
  });

  it('foldPlayer marks folded and acted', () => {
    const p = foldPlayer(active(500));
    expect(p.status).toBe(PlayerStatus.Folded);
    expect(p.hasActed).toBe(true);
    expect(p.lastAction).toBe(PlayerActionType.Fold);
    expect(isInHand(p)).toBe(false);
    expect(canAct(p)).toBe(false);
  });

  it('markActed records the action without touching chips', () => {
    const p = markActed(active(500), PlayerActionType.Call);
    expect(p).toMatchObject({ stack: 500, hasActed: true, lastAction: PlayerActionType.Call });
  });

  it('resetForStreet clears round betting fields only', () => {
    const mid = markActed(commitChips(active(1000), 300).player, PlayerActionType.Bet);
    const next = resetForStreet(mid);
    expect(next).toMatchObject({
      currentBet: 0,
      hasActed: false,
      lastAction: null,
      stack: 700,
      totalInvested: 300,
      status: PlayerStatus.Active,
    });
  });

  it('resetForHand reactivates a player with chips and clears cards/blinds', () => {
    const withChips = resetForHand({
      ...active(500),
      isDealer: true,
      isBigBlind: true,
      totalInvested: 999,
      lastAction: PlayerActionType.Raise,
    });
    expect(withChips).toMatchObject({
      status: PlayerStatus.Active,
      isDealer: false,
      isBigBlind: false,
      totalInvested: 0,
      holeCards: [],
      lastAction: null,
    });
  });

  it('resetForHand sits out players with no chips, keeps eliminated eliminated', () => {
    expect(resetForHand({ ...active(500), status: PlayerStatus.SittingOut }).status).toBe(
      PlayerStatus.SittingOut,
    );
    expect(resetForHand(active(0)).status).toBe(PlayerStatus.SittingOut);
    expect(resetForHand({ ...active(500), status: PlayerStatus.Eliminated }).status).toBe(
      PlayerStatus.Eliminated,
    );
  });
});
