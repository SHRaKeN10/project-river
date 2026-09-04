import { createInterface } from 'node:readline';
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

/**
 * Set a user's password directly in the database and kill their existing
 * logins. For rotating the admin account after a leak, or an out-of-band
 * reset (the app has no self-serve reset wired up yet).
 *
 *   node prisma/set-password.mjs you@example.com
 *     -> prompts for the new password on stdin (not echoed, not in shell history)
 *
 *   NEW_PASSWORD='...' node prisma/set-password.mjs you@example.com
 *     -> non-interactive (avoid: the password lands in your shell history)
 *
 * In production, use the interactive form so nothing is logged:
 *   fly ssh console
 *   # node prisma/set-password.mjs you@example.com
 *
 * Password rules match registration: 10-128 characters. Existing sessions and
 * refresh tokens are revoked, so the user is logged out once their current
 * access token expires (minutes) and cannot refresh past that.
 */

// Same argon2id cost as apps/api/src/auth/password.service.ts - keep in sync.
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

const MIN = 10;
const MAX = 128;

const email = process.argv[2];
if (!email) {
  console.error(
    'usage: node prisma/set-password.mjs <email>   (password via prompt or $NEW_PASSWORD)',
  );
  process.exit(1);
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Mute the echo: overwrite each keystroke the muxer would print.
    const origWrite = rl._writeToOutput?.bind(rl);
    rl._writeToOutput = (str) => {
      if (str.includes(question)) origWrite?.(str);
      else origWrite?.('');
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function readPassword() {
  if (process.env.NEW_PASSWORD) return process.env.NEW_PASSWORD;
  if (process.stdin.isTTY) return promptHidden('new password: ');
  // piped in: take the first line
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return chunks.join('').split('\n')[0];
}

const password = (await readPassword())?.trim();
if (!password || password.length < MIN || password.length > MAX) {
  console.error(`password must be ${MIN}-${MAX} characters`);
  process.exit(1);
}

const prisma = new PrismaClient();
try {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, username: true },
  });
  if (!user) {
    console.error(`no user with email ${email}`);
    process.exit(1);
  }

  const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);
  const now = new Date();

  const [, sessions, tokens] = await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
    prisma.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: now },
    }),
    prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: now },
    }),
  ]);

  console.log(
    `password set for ${user.username} <${email}>; revoked ${sessions.count} session(s), ${tokens.count} refresh token(s)`,
  );
} catch (err) {
  console.error(err);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
