import { blindsLabel, formatCountdown, levelRemainingMs } from './clock';

describe('formatCountdown', () => {
  it('formats mm:ss with an unpadded minute', () => {
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(9_000)).toBe('0:09');
    expect(formatCountdown(65_000)).toBe('1:05');
    expect(formatCountdown(600_000)).toBe('10:00');
  });

  it('adds an hours field past sixty minutes and pads the minutes', () => {
    expect(formatCountdown(3_661_000)).toBe('1:01:01');
  });

  it('clamps a negative remaining time to zero', () => {
    expect(formatCountdown(-5_000)).toBe('0:00');
  });
});

describe('levelRemainingMs', () => {
  it('is the time to the level end', () => {
    expect(levelRemainingMs(10_000, 0, 3_000)).toBe(7_000);
  });

  it('corrects for a device clock that disagrees with the server', () => {
    // skew = serverNow - clientNow = +500 -> the device is 500ms behind, so
    // there is 500ms less left than its own clock would say
    expect(levelRemainingMs(10_000, 500, 3_000)).toBe(6_500);
  });

  it('is null on the final level (no end)', () => {
    expect(levelRemainingMs(null, 0, 0)).toBeNull();
  });
});

describe('blindsLabel', () => {
  it('omits a zero ante', () => {
    expect(blindsLabel({ smallBlind: 100, bigBlind: 200, ante: 0 })).toBe('100/200');
  });

  it('shows an ante in parentheses', () => {
    expect(blindsLabel({ smallBlind: 100, bigBlind: 200, ante: 200 })).toBe('100/200 (200)');
  });
});
