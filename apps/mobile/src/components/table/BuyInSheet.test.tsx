import { fireEvent, render, screen } from '@testing-library/react-native';
import { BuyInSheet } from './BuyInSheet';

const base = {
  visible: true,
  seatNumber: 0,
  minBuyIn: 200,
  maxBuyIn: 2000,
  bigBlind: 20,
  onConfirm: jest.fn(),
  onClose: jest.fn(),
};

describe('BuyInSheet', () => {
  it('lets a funded player pick an amount and sit down', () => {
    const onConfirm = jest.fn();
    render(<BuyInSheet {...base} chipBalance={5000} onConfirm={onConfirm} />);
    fireEvent.press(screen.getByText(/Sit down for/));
    expect(onConfirm).toHaveBeenCalledWith(2000); // 100 BB, capped by ceiling
  });

  it('offers a rebuy instead of the amount picker when the player is broke', () => {
    const onRebuy = jest.fn();
    render(<BuyInSheet {...base} chipBalance={50} onRebuy={onRebuy} />);
    expect(screen.queryByText(/Sit down for/)).toBeNull();
    expect(screen.getByText(/at least 200 chips/)).toBeTruthy();
    fireEvent.press(screen.getByText('Get free chips'));
    expect(onRebuy).toHaveBeenCalled();
  });

  it('hides the rebuy button when no handler is supplied', () => {
    render(<BuyInSheet {...base} chipBalance={50} />);
    expect(screen.queryByText('Get free chips')).toBeNull();
  });
});
