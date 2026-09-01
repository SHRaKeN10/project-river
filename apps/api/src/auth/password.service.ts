import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/** OWASP-recommended argon2id baseline (as of the 2023 cheat sheet):
 * memory 19 MiB, time cost 2, parallelism 1. Tune upward as server headroom allows. */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

@Injectable()
export class PasswordService {
  /** A hash of a random, unguessable value with the same cost parameters as
   * real hashes. Verifying against this when a user isn't found keeps login
   * response timing similar for "wrong password" vs "no such account" -
   * cheap defense against user-enumeration via timing. */
  private readonly dummyHash: Promise<string> = argon2.hash(
    'correct horse battery staple - not a real password',
    ARGON2_OPTIONS,
  );

  hash(plain: string): Promise<string> {
    return argon2.hash(plain, ARGON2_OPTIONS);
  }

  verify(hash: string, plain: string): Promise<boolean> {
    return argon2.verify(hash, plain);
  }

  async verifyDummy(): Promise<void> {
    await argon2.verify(await this.dummyHash, 'irrelevant').catch(() => undefined);
  }
}
