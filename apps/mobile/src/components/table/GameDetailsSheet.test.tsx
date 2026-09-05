import { fireEvent, render, screen } from '@testing-library/react-native';
import type { TableStateView } from '@river/shared-types';
import { GameDetailsSheet } from './GameDetailsSheet';

const view = (over: Partial<TableStateView> = {}): TableStateView =>
  ({
    tableId: 't-1',
    name: 'Rookie Room',
    gameType: 'NLHE',
    smallBlind: 1,
    bigBlind: 2,
    maxSeats: 6,
    minBuyIn: 40,
    maxBuyIn: 400,
    timeChargeAmount: 38,
    timeChargeIntervalMs: 15 * 60_000,
    handId: null,
    handNumber: 0,
    street: 'WAITING',
    buttonSeat: null,
    communityCards: [],
    pot: 0,
    pots: [],
    currentBet: 0,
    seats: [],
    actingSeat: null,
    actionDeadline: null,
    youAreSeat: null,
    legalActions: null,
    ...over,
  }) as TableStateView;

describe('GameDetailsSheet', () => {
  it('shows the table config, including the time charge as fees/interval', () => {
    render(<GameDetailsSheet visible view={view()} onClose={jest.fn()} />);
    expect(screen.getByText('Stakes')).toBeTruthy();
    expect(screen.getByText('1/2')).toBeTruthy();
    expect(screen.getByText('Fees / interval')).toBeTruthy();
    expect(screen.getByText('38 / 15 min')).toBeTruthy();
  });

  it('omits the fees row when the table has no time charge', () => {
    render(<GameDetailsSheet visible view={view({ timeChargeAmount: 0 })} onClose={jest.fn()} />);
    expect(screen.queryByText('Fees / interval')).toBeNull();
  });

  it('spells out the game type', () => {
    render(<GameDetailsSheet visible view={view()} onClose={jest.fn()} />);
    expect(screen.getByText("No-Limit Hold'em")).toBeTruthy();
  });

  it('labels a Pot-Limit Omaha table', () => {
    render(<GameDetailsSheet visible view={view({ gameType: 'PLO' })} onClose={jest.fn()} />);
    expect(screen.getByText('Pot-Limit Omaha')).toBeTruthy();
  });

  it('labels a Big O table', () => {
    render(
      <GameDetailsSheet visible view={view({ gameType: 'OMAHA5_HILO' })} onClose={jest.fn()} />,
    );
    expect(screen.getByText('Big O (Hi-Lo)')).toBeTruthy();
  });

  it('closes on the ✕ button', () => {
    const onClose = jest.fn();
    render(<GameDetailsSheet visible view={view()} onClose={onClose} />);
    fireEvent.press(screen.getByText('✕'));
    expect(onClose).toHaveBeenCalled();
  });
});
