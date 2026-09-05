import { render, screen } from '@testing-library/react-native';
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
  timeChargeAmount: 38,
  timeChargeIntervalMs: 15 * 60_000,
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

describe('LobbyTableCard', () => {
  it('shows the time charge in the stakes line', () => {
    render(
      <LobbyTableCard
        table={table()}
        onOpen={noop}
        onToggleFavorite={noop}
        onToggleWaitlist={noop}
      />,
    );
    expect(screen.getByText(/1\/2 · 6-max · fee 38\/15m/)).toBeTruthy();
  });

  it('omits the fee when the table has no time charge', () => {
    render(
      <LobbyTableCard
        table={table({ timeChargeAmount: 0 })}
        onOpen={noop}
        onToggleFavorite={noop}
        onToggleWaitlist={noop}
      />,
    );
    expect(screen.queryByText(/fee/)).toBeNull();
  });

  it('marks a Pot-Limit Omaha table', () => {
    render(
      <LobbyTableCard
        table={table({ gameType: 'PLO', smallBlind: 5, bigBlind: 10, timeChargeAmount: 0 })}
        onOpen={noop}
        onToggleFavorite={noop}
        onToggleWaitlist={noop}
      />,
    );
    expect(screen.getByText(/PLO · 5\/10 · 6-max/)).toBeTruthy();
  });

  it('does not mark a Hold’em table', () => {
    render(
      <LobbyTableCard
        table={table({ timeChargeAmount: 0 })}
        onOpen={noop}
        onToggleFavorite={noop}
        onToggleWaitlist={noop}
      />,
    );
    expect(screen.queryByText(/PLO/)).toBeNull();
  });
});
