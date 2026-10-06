import { render, screen } from '@testing-library/react-native';
import { TableWatermark } from './TableWatermark';

describe('TableWatermark', () => {
  it('prints the house, the game and the blinds', () => {
    render(<TableWatermark gameType="OMAHA5_HILO" smallBlind={10} bigBlind={20} />);
    expect(screen.getByText('PALACE POKER')).toBeTruthy();
    expect(screen.getByText('Big O (Hi-Lo)')).toBeTruthy();
    expect(screen.getByText('Blinds 10/20')).toBeTruthy();
  });

  it('falls back to the raw game type for an unknown game', () => {
    render(<TableWatermark gameType="STUD" smallBlind={1} bigBlind={2} />);
    expect(screen.getByText('STUD')).toBeTruthy();
  });
});
