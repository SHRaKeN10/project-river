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
  isStraddle: false,
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

  it('shows a STR chip for the straddle seat, and not otherwise', () => {
    const { rerender } = render(
      <SeatPod
        seat={seat({ isStraddle: true })}
        isHero
        isActing={false}
        isButton={false}
        actionDeadline={null}
      />,
    );
    expect(screen.getByText('STR')).toBeTruthy();
    rerender(
      <SeatPod
        seat={seat({ isStraddle: false })}
        isHero
        isActing={false}
        isButton={false}
        actionDeadline={null}
      />,
    );
    expect(screen.queryByText('STR')).toBeNull();
  });

  it('shows four face-up cards for an Omaha hero', () => {
    render(
      <SeatPod
        seat={seat({ holeCards: ['As', 'Kd', 'Qh', 'Jc'] })}
        isHero
        isActing={false}
        isButton={false}
        actionDeadline={null}
        holeCardCount={4}
      />,
    );
    for (const rank of ['A', 'K', 'Q', 'J']) {
      expect(screen.getByText(rank)).toBeTruthy();
    }
  });

  it('draws holeCardCount face-down cards for an opponent still in the hand', () => {
    render(
      <SeatPod
        seat={seat({ holeCards: null, status: 'ACTIVE' })}
        isHero={false}
        isActing={false}
        isButton={false}
        actionDeadline={null}
        holeCardCount={4}
      />,
    );
    expect(screen.getAllByLabelText('Face-down card')).toHaveLength(4);
  });

  it('draws five face-down cards for a Big O opponent', () => {
    render(
      <SeatPod
        seat={seat({ holeCards: null, status: 'ACTIVE' })}
        isHero={false}
        isActing={false}
        isButton={false}
        actionDeadline={null}
        holeCardCount={5}
      />,
    );
    expect(screen.getAllByLabelText('Face-down card')).toHaveLength(5);
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
