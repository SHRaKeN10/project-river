import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
const p = new PrismaClient();
const hash = await argon2.hash('a-strong-passphrase', { type: argon2.argon2id });
await p.user.upsert({
  where: { email: 'loadadm@ex.test' },
  update: { role: 'ADMIN', passwordHash: hash, username: 'loadadm', playChips: 1_000_000 },
  create: {
    email: 'loadadm@ex.test',
    username: 'loadadm',
    passwordHash: hash,
    role: 'ADMIN',
    playChips: 1_000_000,
  },
});
// clean any leftover load tables/hands
const del = await p.pokerTable.deleteMany({ where: { name: { contains: 'load' } } });
console.log('loadadm ready (ADMIN); cleared', del.count, 'old load tables');
await p.$disconnect();
