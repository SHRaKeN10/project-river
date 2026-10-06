import type { LobbyTableView } from '@river/shared-types';
import { filterTables, gameBadge, stakeTierOf, type LobbyFilters } from './filters';

const table = (over: Partial<LobbyTableView>): LobbyTableView => ({
  id: 't',
  name: 'T',
  gameType: 'NLHE',
  smallBlind: 5,
  bigBlind: 10,
  ante: 0,
  maxSeats: 6,
  seatedCount: 2,
  openSeats: 4,
  minBuyIn: 200,
  maxBuyIn: 2000,
  timeChargeAmount: 0,
  timeChargeIntervalMs: 0,
  status: 'ACTIVE',
  isPrivate: false,
  handInProgress: false,
  avgPot: 0,
  handsPlayed: 0,
  waitlistCount: 0,
  isFavorite: false,
  onWaitlist: false,
  youAreSeated: false,
  ...over,
});

const none: LobbyFilters = { game: 'ALL', tier: null, openOnly: false, favoritesOnly: false };

describe('stakeTierOf', () => {
  it('buckets by big blind', () => {
    expect(stakeTierOf(2)).toBe('low');
    expect(stakeTierOf(10)).toBe('low');
    expect(stakeTierOf(20)).toBe('mid');
    expect(stakeTierOf(50)).toBe('mid');
    expect(stakeTierOf(100)).toBe('high');
  });
});

describe('gameBadge', () => {
  it('labels each game', () => {
    expect(gameBadge('NLHE')).toBe('NLH');
    expect(gameBadge('PLO')).toBe('PLO');
    expect(gameBadge('OMAHA5_HILO')).toBe('BIG O');
    expect(gameBadge('STUD')).toBe('STUD');
  });
});

describe('filterTables', () => {
  const all = [
    table({ id: 'a', gameType: 'NLHE', bigBlind: 10 }),
    table({ id: 'b', gameType: 'PLO', bigBlind: 10 }),
    table({ id: 'c', gameType: 'OMAHA5_HILO', bigBlind: 20, openSeats: 0, seatedCount: 6 }),
    table({ id: 'd', gameType: 'NLHE', bigBlind: 100, isFavorite: true }),
  ];
  const ids = (f: Partial<LobbyFilters>) => filterTables(all, { ...none, ...f }).map((t) => t.id);

  it('returns everything with no filters', () => {
    expect(ids({})).toEqual(['a', 'b', 'c', 'd']);
  });

  it('filters by game', () => {
    expect(ids({ game: 'PLO' })).toEqual(['b']);
    expect(ids({ game: 'OMAHA5_HILO' })).toEqual(['c']);
  });

  it('filters by stakes tier', () => {
    expect(ids({ tier: 'low' })).toEqual(['a', 'b']);
    expect(ids({ tier: 'mid' })).toEqual(['c']);
    expect(ids({ tier: 'high' })).toEqual(['d']);
  });

  it('combines game and tier', () => {
    expect(ids({ game: 'NLHE', tier: 'low' })).toEqual(['a']);
  });

  it('open-only hides full tables unless you are on their waitlist', () => {
    expect(ids({ openOnly: true })).toEqual(['a', 'b', 'd']);
    const withWaitlist = [table({ id: 'w', openSeats: 0, onWaitlist: true })];
    expect(filterTables(withWaitlist, { ...none, openOnly: true })).toHaveLength(1);
  });

  it('favourites only', () => {
    expect(ids({ favoritesOnly: true })).toEqual(['d']);
  });
});
