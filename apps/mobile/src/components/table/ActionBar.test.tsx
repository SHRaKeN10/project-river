import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ActionOptionView } from '@river/shared-types';
import { ActionBar } from './ActionBar';

const setup = (options: ActionOptionView[], onAct = jest.fn()) => {
  render(<ActionBar options={options} bigBlind={10} pot={100} currentBet={0} onAct={onAct} />);
  return onAct;
};

describe('ActionBar', () => {
  it('shows fold + check when the player can check', () => {
    setup([{ kind: 'FOLD' }, { kind: 'CHECK' }, { kind: 'BET', min: 10, max: 500 }]);
    expect(screen.getByText('Fold')).toBeTruthy();
    expect(screen.getByText('Check')).toBeTruthy();
    expect(screen.getByText('Bet')).toBeTruthy();
  });

  it('shows the call amount when facing a bet', () => {
    setup([
      { kind: 'FOLD' },
      { kind: 'CALL', callAmount: 40 },
      { kind: 'RAISE', min: 80, max: 1000 },
    ]);
    expect(screen.getByText('Call 40')).toBeTruthy();
  });

  it('emits a fold immediately', () => {
    const onAct = setup([{ kind: 'FOLD' }, { kind: 'CHECK' }]);
    fireEvent.press(screen.getByText('Fold'));
    expect(onAct).toHaveBeenCalledWith({ type: 'FOLD' });
  });

  it('opens the sizing panel and confirms a raise-to amount', () => {
    const onAct = setup([
      { kind: 'FOLD' },
      { kind: 'CALL', callAmount: 20 },
      { kind: 'RAISE', min: 60, max: 1000 },
    ]);

    fireEvent.press(screen.getByText('Raise'));
    // starts at the minimum
    expect(screen.getByText('Raise to 60')).toBeTruthy();

    // +10 (one big blind)
    fireEvent.press(screen.getByText('+'));
    expect(screen.getByText('Raise to 70')).toBeTruthy();

    fireEvent.press(screen.getByText('Raise 70'));
    expect(onAct).toHaveBeenCalledWith({ type: 'RAISE', amount: 70 });
  });

  it('clamps a preset to the legal max', () => {
    setup([{ kind: 'FOLD' }, { kind: 'CHECK' }, { kind: 'BET', min: 10, max: 50 }]);
    fireEvent.press(screen.getByText('Bet'));
    fireEvent.press(screen.getByText('Pot')); // pot-size would exceed 50
    expect(screen.getByText('Bet to 50')).toBeTruthy();
  });

  it('on a pot-limit table, "Pot" is the exact ceiling and there is no separate "Max"', () => {
    render(
      <ActionBar
        options={[
          { kind: 'FOLD' },
          { kind: 'CALL', callAmount: 20 },
          { kind: 'RAISE', min: 60, max: 240 },
        ]}
        bigBlind={10}
        pot={100}
        currentBet={0}
        potLimit
        onAct={jest.fn()}
      />,
    );
    fireEvent.press(screen.getByText('Raise'));
    expect(screen.queryByText('Max')).toBeNull();
    fireEvent.press(screen.getByText('Pot'));
    expect(screen.getByText('Raise to 240')).toBeTruthy();
  });
});
