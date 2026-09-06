import { render, screen } from '@testing-library/react-native';
import type { TournamentClockState } from '@river/shared-types';
import { TournamentClock } from './TournamentClock';

const clock = (over: Partial<TournamentClockState> = {}): TournamentClockState => ({
  tournamentId: 't1',
  level: 4,
  smallBlind: 150,
  bigBlind: 300,
  ante: 300,
  isBreak: false,
  levelEndsAt: Date.now() + 5 * 60_000,
  levelDurationMs: 600_000,
  serverNow: Date.now(),
  handForHand: false,
  playersLeft: 20,
  placesPaid: 5,
  tableCount: 3,
  ...over,
});

describe('TournamentClock', () => {
  it('shows the level and the blinds with the ante', () => {
    render(<TournamentClock clock={clock()} />);
    expect(screen.getByText('Level 4')).toBeTruthy();
    expect(screen.getByText(/150\/300 \(300\)/)).toBeTruthy();
  });

  it('says "Final level" when the level has no end', () => {
    render(<TournamentClock clock={clock({ levelEndsAt: null })} />);
    expect(screen.getByText('Final level')).toBeTruthy();
  });

  it('labels a break in the compact variant', () => {
    render(<TournamentClock clock={clock({ isBreak: true })} variant="compact" />);
    expect(screen.getByText(/^Break ·/)).toBeTruthy();
  });
});
