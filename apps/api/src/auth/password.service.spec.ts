import { PasswordService } from './password.service';

jest.setTimeout(20000); // argon2id hashing is deliberately slow

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes and verifies a matching password', async () => {
    const hash = await service.hash('correct-horse-battery-staple');
    expect(hash).not.toEqual('correct-horse-battery-staple');
    await expect(service.verify(hash, 'correct-horse-battery-staple')).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await service.hash('correct-horse-battery-staple');
    await expect(service.verify(hash, 'wrong-password')).resolves.toBe(false);
  });

  it('produces a different hash each time (random salt)', async () => {
    const a = await service.hash('same-password');
    const b = await service.hash('same-password');
    expect(a).not.toEqual(b);
  });

  it('verifyDummy resolves without throwing', async () => {
    await expect(service.verifyDummy()).resolves.toBeUndefined();
  });
});
