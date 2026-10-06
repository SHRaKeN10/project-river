import { fireEvent, render, screen } from '@testing-library/react-native';
import type { LobbyTableView } from '@river/shared-types';
import { LobbyTableCard } from './LobbyTableCard';

const table = (over: Partial<LobbyTableView> = {}): LobbyTableView => ({
  id: 't-1',
  name: 'Rookie Room',
  gameType: 'NLHE',
  smallBlind: 1,
  bigBlind: 2,
  ante: 0,
  maxSeats: 6,
  seatedCount: 2,
  openSeats: 4,
  minBuyIn: 40,
  maxBuyIn: 400,
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

const noop = jest.fn();
const renderCard = (t: LobbyTableView, onOpen: jest.Mock = noop) =>
  render(
    <LobbyTableCard table={t} onOpen={onOpen} onToggleFavorite={noop} onToggleWaitlist={noop} />,
  );

describe('LobbyTableCard', () => {
  it('shows the name, blinds, game badge and minimum buy-in', () => {
    renderCard(table());
    expect(screen.getByText('Rookie Room')).toBeTruthy();
    expect(screen.getByText('1/2')).toBeTruthy();
    expect(screen.getByText('NLH')).toBeTruthy();
    expect(screen.getByText('40')).toBeTruthy();
    expect(screen.getByText('Min buy-in')).toBeTruthy();
  });

  it('labels the game on Omaha tables', () => {
    renderCard(table({ gameType: 'PLO' }));
    expect(screen.getByText('PLO')).toBeTruthy();
  });

  it('labels Big O tables', () => {
    renderCard(table({ gameType: 'OMAHA5_HILO' }));
    expect(screen.getByText('BIG O')).toBeTruthy();
  });

  it('shows seats taken and how many are open', () => {
    renderCard(table({ seatedCount: 2, openSeats: 4 }));
    expect(screen.getByText('2/6')).toBeTruthy();
    expect(screen.getByText('4 open')).toBeTruthy();
  });

  it('labels the stakes tier on the spine', () => {
    renderCard(table({ bigBlind: 20 }));
    expect(screen.getByText('MID')).toBeTruthy();
  });

  it('shows ante and the time charge when the table has them', () => {
    renderCard(table({ ante: 5, timeChargeAmount: 38, timeChargeIntervalMs: 15 * 60_000 }));
    expect(screen.getByText('Ante 5 · Fee 38/15m')).toBeTruthy();
  });

  it('omits the fee line when there is no ante or time charge', () => {
    renderCard(table());
    expect(screen.queryByText(/Fee|Ante/)).toBeNull();
  });

  it('offers the waitlist on a full table you are not seated at', () => {
    renderCard(table({ openSeats: 0, seatedCount: 6, waitlistCount: 2 }));
    expect(screen.getByText('Full · 2 waiting')).toBeTruthy();
    expect(screen.getByText('Join waitlist')).toBeTruthy();
  });

  it('flags the table you are seated at', () => {
    renderCard(table({ youAreSeated: true }));
    expect(screen.getByText("You're seated")).toBeTruthy();
  });

  it('opens the table when the row is tapped', () => {
    const onOpen = jest.fn();
    renderCard(table(), onOpen);
    fireEvent.press(screen.getByText('Rookie Room'));
    expect(onOpen).toHaveBeenCalledWith('t-1');
  });
});
