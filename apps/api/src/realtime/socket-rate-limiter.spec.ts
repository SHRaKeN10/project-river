import { SocketRateLimiter } from './socket-rate-limiter';

describe('SocketRateLimiter', () => {
  it('allows a burst up to capacity, then blocks', () => {
    const rl = new SocketRateLimiter(() => 0);
    // action class: capacity 15
    const results = Array.from({ length: 18 }, () => rl.allow('s1', 'action'));
    expect(results.slice(0, 15).every(Boolean)).toBe(true);
    expect(results.slice(15).some(Boolean)).toBe(false);
  });

  it('refills over time at the sustained rate', () => {
    let now = 0;
    const rl = new SocketRateLimiter(() => now);
    for (let i = 0; i < 15; i += 1) rl.allow('s1', 'action'); // drain
    expect(rl.allow('s1', 'action')).toBe(false);

    now += 1000; // action refills 3/sec
    expect(rl.allow('s1', 'action')).toBe(true);
    expect(rl.allow('s1', 'action')).toBe(true);
    expect(rl.allow('s1', 'action')).toBe(true);
    expect(rl.allow('s1', 'action')).toBe(false);
  });

  it('keeps classes and sockets independent', () => {
    const rl = new SocketRateLimiter(() => 0);
    for (let i = 0; i < 5; i += 1) rl.allow('s1', 'chat');
    expect(rl.allow('s1', 'chat')).toBe(false); // chat drained
    expect(rl.allow('s1', 'action')).toBe(true); // other class fine
    expect(rl.allow('s2', 'chat')).toBe(true); // other socket fine
  });

  it('forgets a socket on disconnect', () => {
    const rl = new SocketRateLimiter(() => 0);
    rl.allow('s1', 'action');
    rl.allow('s1', 'chat');
    expect(rl.size).toBeGreaterThan(0);
    rl.forget('s1');
    expect(rl.size).toBe(0);
  });
});
