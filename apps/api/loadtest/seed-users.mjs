// Pre-create N load-test users + write their signed access tokens to _tokens.json
// so the load harness skips register/login throttles.
// node _seedusers.mjs <count> <jwtAccessSecret>
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';

const N = Number(process.argv[2] ?? 100);
const SECRET = process.argv[3];
if (!SECRET) throw new Error('pass the JWT_ACCESS_SECRET as arg 2');

const p = new PrismaClient();
const hash = await argon2.hash('a-strong-passphrase', { type: argon2.argon2id });
await p.user.deleteMany({ where: { email: { contains: 'loaduser_' } } });
await p.user.createMany({
  data: Array.from({ length: N }, (_, i) => ({
    email: `loaduser_${i}@ex.test`,
    username: `loaduser_${i}`,
    passwordHash: hash,
    playChips: 1_000_000,
  })),
  skipDuplicates: true,
});
const users = await p.user.findMany({
  where: { email: { contains: 'loaduser_' } },
  select: { id: true },
  orderBy: { username: 'asc' },
});
const tokens = users.map((u) => ({
  id: u.id,
  token: jwt.sign({ sub: u.id, role: 'PLAYER', sid: randomUUID() }, SECRET, { expiresIn: 3600 }),
}));
writeFileSync(new URL('./tokens.json', import.meta.url), JSON.stringify(tokens));
console.log(`seeded ${tokens.length} users + tokens`);
await p.$disconnect();
