import { act, render, screen } from '@testing-library/react-native';
import { secondsLeft, TurnTimer } from './TurnTimer';

describe('secondsLeft', () => {
  it('rounds up and never goes negative', () => {
    expect(secondsLeft(10_000, 0)).toBe(10);
    expect(secondsLeft(10_000, 500)).toBe(10); // 9.5s left reads 10
    expect(secondsLeft(10_000, 9_001)).toBe(1); // under a second left reads 1
    expect(secondsLeft(10_000, 10_000)).toBe(0);
    expect(secondsLeft(10_000, 12_000)).toBe(0);
  });
});

describe('TurnTimer', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('counts the seconds left down as time passes', () => {
    render(<TurnTimer deadline={Date.now() + 12_000} />);
    expect(screen.getByText('12s')).toBeTruthy();
    act(() => {
      jest.advanceTimersByTime(5_000);
    });
    expect(screen.getByText('7s')).toBeTruthy();
    act(() => {
      jest.advanceTimersByTime(7_000);
    });
    expect(screen.getByText('0s')).toBeTruthy();
  });

  it('restarts from the new deadline', () => {
    const { rerender } = render(<TurnTimer deadline={Date.now() + 5_000} />);
    expect(screen.getByText('5s')).toBeTruthy();
    rerender(<TurnTimer deadline={Date.now() + 20_000} />);
    expect(screen.getByText('20s')).toBeTruthy();
  });
});
