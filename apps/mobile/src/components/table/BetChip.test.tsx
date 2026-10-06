import { render, screen } from '@testing-library/react-native';
import { BetChip } from './BetChip';

describe('BetChip', () => {
  it('shows the amount with thousands separators', () => {
    render(<BetChip amount={1250} x={100} y={100} width={70} />);
    expect(screen.getByText('1,250')).toBeTruthy();
    expect(screen.getByLabelText('Bet 1250')).toBeTruthy();
  });
});
