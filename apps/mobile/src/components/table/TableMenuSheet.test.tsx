import { fireEvent, render, screen } from '@testing-library/react-native';
import { TableMenuSheet } from './TableMenuSheet';

const base = {
  visible: true,
  onClose: jest.fn(),
  onGameDetails: jest.fn(),
  onLeave: jest.fn(),
  onToggleSitOut: jest.fn(),
  straddleOn: null,
  onToggleStraddle: jest.fn(),
};

describe('TableMenuSheet', () => {
  it('opens game details (and closes the menu)', () => {
    const onClose = jest.fn();
    const onGameDetails = jest.fn();
    render(
      <TableMenuSheet
        {...base}
        sittingOut={null}
        onClose={onClose}
        onGameDetails={onGameDetails}
      />,
    );
    fireEvent.press(screen.getByText('Game details'));
    expect(onGameDetails).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('hides the sit-out row when the viewer is not seated', () => {
    render(<TableMenuSheet {...base} sittingOut={null} />);
    expect(screen.queryByText('Sit out')).toBeNull();
    expect(screen.queryByText('Sit in')).toBeNull();
  });

  it('offers Sit out for a seated, active player and toggles it', () => {
    const onToggleSitOut = jest.fn();
    render(<TableMenuSheet {...base} sittingOut={false} onToggleSitOut={onToggleSitOut} />);
    fireEvent.press(screen.getByText('Sit out'));
    expect(onToggleSitOut).toHaveBeenCalledWith(true);
  });

  it('offers Sit in for a sitting-out player', () => {
    render(<TableMenuSheet {...base} sittingOut />);
    expect(screen.getByText('Sit in')).toBeTruthy();
  });

  it('leaves the table', () => {
    const onLeave = jest.fn();
    render(<TableMenuSheet {...base} sittingOut={null} onLeave={onLeave} />);
    fireEvent.press(screen.getByText('Leave table'));
    expect(onLeave).toHaveBeenCalled();
  });

  it('hides the straddle row when the table does not allow it', () => {
    render(<TableMenuSheet {...base} sittingOut={false} straddleOn={null} />);
    expect(screen.queryByText('Straddle (UTG)')).toBeNull();
  });

  it('toggles the straddle for a seated player', () => {
    const onToggleStraddle = jest.fn();
    render(
      <TableMenuSheet
        {...base}
        sittingOut={false}
        straddleOn={false}
        onToggleStraddle={onToggleStraddle}
      />,
    );
    expect(screen.getByText('Off')).toBeTruthy();
    fireEvent.press(screen.getByText('Straddle (UTG)'));
    expect(onToggleStraddle).toHaveBeenCalledWith(true);
  });
});
