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
});
