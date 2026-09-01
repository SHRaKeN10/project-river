import {
  canAct,
  commitChips,
  createPlayer,
  foldPlayer,
  isInHand,
  markActed,
  PlayerActionType,
  PlayerStatus,
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
