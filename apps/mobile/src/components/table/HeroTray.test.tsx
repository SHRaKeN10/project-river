import { render, screen } from '@testing-library/react-native';
import { HeroTray, heroCardSize } from './HeroTray';

describe('HeroTray', () => {
  it('draws every hole card of a 5-card Big O hand', () => {
    render(<HeroTray cards={['5d', '8s', 'Jd', '9c', 'Kd']} folded={false} size="lg" />);
    for (const rank of ['5', '8', 'J', '9', 'K']) expect(screen.getByText(rank)).toBeTruthy();
  });

  it('shows the latest event above the cards', () => {
    render(
      <HeroTray
        cards={['As', 'Kd']}
        folded={false}
        feedText="Ana wins 300 with a Flush"
        size="md"
      />,
    );
    expect(screen.getByText('Ana wins 300 with a Flush')).toBeTruthy();
  });

  it('renders nothing with no cards and no event', () => {
    const { toJSON } = render(<HeroTray cards={[]} folded={false} size="md" />);
    expect(toJSON()).toBeNull();
  });
});

describe('heroCardSize', () => {
  it('uses large cards when the hand fits, medium otherwise', () => {
    expect(heroCardSize(5, 390, 844)).toBe('lg');
    expect(heroCardSize(5, 320, 568)).toBe('md'); // short screen
    expect(heroCardSize(5, 300, 800)).toBe('md'); // too narrow for five large cards
    expect(heroCardSize(2, 375, 667)).toBe('md');
  });
});
