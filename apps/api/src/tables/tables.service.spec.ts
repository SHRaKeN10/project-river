import { Prisma } from '@prisma/client';
import { isDeadlock, retryOnDeadlock } from './tables.service';

const deadlock = () =>
  new Prisma.PrismaClientKnownRequestError(
    'Transaction failed due to a write conflict or a deadlock',
    {
      code: 'P2034',
      clientVersion: 'test',
    },
  );

describe('isDeadlock', () => {
  it('matches P2034 and a raw 40P01 message', () => {
    expect(isDeadlock(deadlock())).toBe(true);
    expect(
      isDeadlock(
        new Prisma.PrismaClientKnownRequestError('… deadlock detected …', {
          code: 'P2010',
          clientVersion: 'test',
        }),
      ),
    ).toBe(true);
  });

  it('does not match other errors', () => {
    expect(isDeadlock(new Error('boom'))).toBe(false);
    expect(
      isDeadlock(
        new Prisma.PrismaClientKnownRequestError('unique constraint', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      ),
    ).toBe(false);
  });
});

describe('retryOnDeadlock', () => {
  it('retries a deadlock and returns once it clears', async () => {
    let calls = 0;
    const result = await retryOnDeadlock(async () => {
      calls += 1;
      if (calls < 3) throw deadlock();
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('rethrows a non-deadlock error immediately without retrying', async () => {
    let calls = 0;
    await expect(
      retryOnDeadlock(async () => {
        calls += 1;
        throw new Error('not a deadlock');
      }),
    ).rejects.toThrow('not a deadlock');
    expect(calls).toBe(1);
  });

  it('gives up after the attempt limit', async () => {
    let calls = 0;
    await expect(
      retryOnDeadlock(async () => {
        calls += 1;
        throw deadlock();
      }, 3),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(calls).toBe(3);
  });
});
