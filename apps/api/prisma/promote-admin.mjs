import { PrismaClient } from '@prisma/client';

/**
 * Promote an already-registered user to ADMIN (needed for /api/ops/metrics and
 * the admin table controls). The user must sign up through the app first.
 *
 *   node prisma/promote-admin.mjs someone@example.com
 *
 * In production: `fly ssh console -C "node prisma/promote-admin.mjs you@ex.com"`
 */
const email = process.argv[2];
if (!email) {
  console.error('usage: node prisma/promote-admin.mjs <email>');
  process.exit(1);
}

const prisma = new PrismaClient();
try {
  const user = await prisma.user.update({
    where: { email },
    data: { role: 'ADMIN' },
    select: { id: true, email: true, username: true, role: true },
  });
  console.log('promoted:', user);
} catch (err) {
  console.error(err.code === 'P2025' ? `no user with email ${email}` : err);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
