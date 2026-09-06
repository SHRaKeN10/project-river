import { render, screen } from '@testing-library/react-native';
import { CommunityBoard } from './CommunityBoard';

describe('CommunityBoard', () => {
  it('shows no bomb-pot banner on a normal hand', () => {
    render(<CommunityBoard cards={[]} pot={0} streetLabel="Preflop" bombPot={null} />);
    expect(screen.queryByText(/BOMB POT/i)).toBeNull();
  });

  it('shows the bomb-pot banner with the contribution amount during a bomb hand', () => {
    render(
      <CommunityBoard
        cards={['As', 'Kd', '7c']}
        pot={60}
        streetLabel="Flop"
        bombPot={{ active: true, amount: 20, nextInHands: 0 }}
      />,
    );
    expect(screen.getByText('💣 BOMB POT')).toBeTruthy();
    expect(screen.getByText(/Everyone posted 20/)).toBeTruthy();
    expect(screen.getByText(/no preflop betting/)).toBeTruthy();
  });

  it('hides the banner when a bomb-pot table is between bomb hands', () => {
    render(
      <CommunityBoard
        cards={[]}
        pot={0}
        streetLabel="Preflop"
        bombPot={{ active: false, amount: 20, nextInHands: 7 }}
      />,
    );
    expect(screen.queryByText(/BOMB POT/i)).toBeNull();
  });

  it('renders a single board normally and two boards when the hand ran twice', () => {
    const { rerender } = render(
      <CommunityBoard cards={['As', 'Kd', '7c', '2h', '9s']} pot={200} streetLabel="River" />,
    );
    expect(screen.queryByText('RUNNING IT TWICE')).toBeNull();

    rerender(
      <CommunityBoard
        cards={['As', 'Kd', '7c', '2h', '9s']}
        secondBoard={['Qc', 'Jc', 'Tc', '3d', '4d']}
        pot={200}
        streetLabel="River"
      />,
    );
    expect(screen.getByText('RUNNING IT TWICE')).toBeTruthy();
    // both boards' cards are on screen
    expect(screen.getByText('Q')).toBeTruthy();
    expect(screen.getByText('9')).toBeTruthy();
  });
});
