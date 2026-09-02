import { fireEvent, render, screen } from '@testing-library/react-native';
import type { PublicSeatView } from '@river/shared-types';
import { SeatPod } from './SeatPod';

const seat = (over: Partial<PublicSeatView>): PublicSeatView => ({
  seatNumber: 0,
  userId: 'u1',
  username: 'Alice',
  avatarUrl: null,
  stack: 1000,
  currentBet: 0,
  totalInvested: 0,
  status: 'ACTIVE',
  lastAction: null,
  isDealer: false,
  isSmallBlind: false,
  isBigBlind: false,
  connected: true,
  holeCards: null,
  ...over,
});

describe('SeatPod', () => {
  it('renders an empty seat as a Sit target', () => {
    const onSit = jest.fn();
    render(
      <SeatPod
        seat={seat({ userId: null, username: null, seatNumber: 3 })}
        isHero={false}
        isActing={false}
        isButton={false}
        actionDeadline={null}
        onSit={onSit}
      />,
    );
    fireEvent.press(screen.getByText('Sit'));
    expect(onSit).toHaveBeenCalledWith(3);
  });

  it('shows the occupant name and stack', () => {
    render(
      <SeatPod
        seat={seat({ stack: 1234 })}
        isHero
        isActing={false}
        isButton={false}
        actionDeadline={null}
      />,
    );
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('1,234')).toBeTruthy();
  });

  it('shows the hero’s own hole cards face up', () => {
    render(
      <SeatPod
        seat={seat({ holeCards: ['As', 'Kd'] })}
        isHero
        isActing={false}
        isButton={false}
        actionDeadline={null}
      />,
    );
    expect(screen.getByText('A')).toBeTruthy();
    expect(screen.getByText('K')).toBeTruthy();
  });

  it('marks a folded seat', () => {
    render(
      <SeatPod
        seat={seat({ status: 'FOLDED' })}
        isHero={false}
        isActing={false}
        isButton={false}
        actionDeadline={null}
      />,
    );
    expect(screen.getByText('folded')).toBeTruthy();
  });
});
