import { render } from '@testing-library/react-native';
import { seatRing } from '../../features/table/layout';
import { ChipFlights } from './ChipFlights';

describe('ChipFlights', () => {
  const slots = seatRing(6, 0, 340, 104);
  const props = {
    slots,
    betSpots: new Map([[0, { x: 170, y: 400 }]]),
    feltWidth: 340,
    feltHeight: 520,
    podWidth: 104,
    onDone: jest.fn(),
  };

  it('draws a few chips for each flight without blocking touches', () => {
    const { toJSON } = render(
      <ChipFlights
        {...props}
        flights={[
          { id: 'f1', kind: 'bet', seat: 0, amount: 50, delay: 0 },
          { id: 'f2', kind: 'collect', seat: 1, amount: 40, delay: 0 },
          { id: 'f3', kind: 'award', seat: 2, amount: 100, delay: 500 },
        ]}
      />,
    );
    const json = JSON.stringify(toJSON());
    expect(json).toContain('"pointerEvents":"none"');
    // three chips per flight
    expect(json.match(/Animated|"opacity"/g)?.length).toBeGreaterThanOrEqual(9);
  });

  it('ignores a flight for a seat that is not on the table', () => {
    const { toJSON } = render(
      <ChipFlights
        {...props}
        flights={[{ id: 'x', kind: 'bet', seat: 42, amount: 5, delay: 0 }]}
      />,
    );
    expect(toJSON()).toBeNull();
  });
});
