import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const t = await p.pokerTable.deleteMany({ where: { name: { contains: 'load' } } });
const h = await p.chipLedgerEntry.deleteMany({ where: { user: { email: { contains: 'load' } } } });
const u = await p.user.deleteMany({ where: { email: { contains: 'load' } } });
console.log(`removed ${t.count} tables, ${h.count} ledger rows, ${u.count} users`);
await p.$disconnect();
