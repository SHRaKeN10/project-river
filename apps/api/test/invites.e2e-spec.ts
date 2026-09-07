import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AppConfigService } from '../src/config/app-config.service';
import { PrismaService } from '../src/infra/prisma/prisma.service';

/**
 * Closed-alpha invite codes (ADR-0033). `INVITE_ONLY` is read at request time,
 * so we flip it by spying on the resolved `AppConfigService` singleton rather
 * than through `process.env` (which `@nestjs/config` freezes at import).
 */
describe('Invite codes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let config: AppConfigService;
  let inviteOnly = false;

  // short unique tag so usernames stay <= 20 chars
  const tag = Math.random().toString(36).slice(2, 8);
  const password = 'super-secret-passphrase';
  const adminEmail = `inv_${tag}_adm@ex.test`;
  const emails: string[] = [adminEmail];
  let adminToken = '';
  let n = 0;
  const codes: string[] = [];

  const reg = (over: Record<string, unknown> = {}) => {
    n += 1;
    const email = `inv_${tag}_${n}@ex.test`;
    emails.push(email);
    return request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, username: `inv_${tag}_${n}`, password, ...over });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['health/live', 'health/ready'] });
    await app.init();
    prisma = app.get(PrismaService);
    config = app.get(AppConfigService);

    const realGet = config.get.bind(config) as (k: string) => unknown;
    jest
      .spyOn(config, 'get')
      .mockImplementation(((k: string) =>
        k === 'INVITE_ONLY' ? inviteOnly : realGet(k)) as typeof config.get);

    await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: adminEmail, username: `inv_${tag}_adm`.slice(0, 20), password });
    await prisma.user.update({ where: { email: adminEmail }, data: { role: 'ADMIN' } });
    adminToken = (
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ emailOrUsername: adminEmail, password })
    ).body.tokens.accessToken;
  }, 30000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await prisma.inviteCode.deleteMany({ where: { code: { in: codes } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { in: emails } } }).catch(() => undefined);
    await app?.close();
  });

  const auth = { Authorization: () => `Bearer ${adminToken}` };
  const mint = (body: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post('/api/auth/invites')
      .set('Authorization', auth.Authorization())
      .send(body);

  it('mints an invite (admin only) and lists it', async () => {
    const res = await mint({ maxUses: 2, note: 'batch 1' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ maxUses: 2, usedCount: 0, note: 'batch 1' });
    expect(res.body.code).toMatch(/^river-/);
    codes.push(res.body.code);

    const list = await request(app.getHttpServer())
      .get('/api/auth/invites')
      .set('Authorization', auth.Authorization());
    expect(list.body.some((i: { code: string }) => i.code === res.body.code)).toBe(true);
  });

  it('refuses invite minting to a non-admin', async () => {
    const player = await reg();
    const res = await request(app.getHttpServer())
      .post('/api/auth/invites')
      .set('Authorization', `Bearer ${player.body.tokens.accessToken}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('open mode: registration works with no code', async () => {
    inviteOnly = false;
    const res = await reg();
    expect(res.status).toBe(201);
    expect(res.body.user).toBeDefined();
  });

  describe('with INVITE_ONLY on', () => {
    beforeAll(() => {
      inviteOnly = true;
    });
    afterAll(() => {
      inviteOnly = false;
    });

    it('rejects registration with no code (INVITE_REQUIRED)', async () => {
      const res = await reg();
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INVITE_REQUIRED');
    });

    it('rejects an unknown code (INVITE_INVALID)', async () => {
      const res = await reg({ inviteCode: 'river-zzzz-zzzzzz' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INVITE_INVALID');
    });

    it('accepts a valid code, records it, and increments usedCount', async () => {
      const code = (await mint({ maxUses: 1 })).body.code as string;
      codes.push(code);

      const res = await reg({ inviteCode: code.toUpperCase() }); // case-insensitive
      expect(res.status).toBe(201);

      const user = await prisma.user.findUnique({ where: { email: emails[emails.length - 1] } });
      expect(user?.invitedViaCode).toBe(code);
      const row = await prisma.inviteCode.findUnique({ where: { code } });
      expect(row?.usedCount).toBe(1);

      // single-use is now spent
      const again = await reg({ inviteCode: code });
      expect(again.status).toBe(403);
      expect(again.body.code).toBe('INVITE_INVALID');
    });

    it('rejects an expired code', async () => {
      const code = (await mint({ expiresInHours: 1 })).body.code as string;
      codes.push(code);
      await prisma.inviteCode.update({
        where: { code },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      const res = await reg({ inviteCode: code });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INVITE_INVALID');
    });

    it('a multi-use code cannot be over-redeemed under concurrency', async () => {
      const code = (await mint({ maxUses: 2 })).body.code as string;
      codes.push(code);

      const results = await Promise.all([
        reg({ inviteCode: code }),
        reg({ inviteCode: code }),
        reg({ inviteCode: code }),
        reg({ inviteCode: code }),
        reg({ inviteCode: code }),
      ]);
      const ok = results.filter((r) => r.status === 201).length;
      expect(ok).toBe(2);
      const row = await prisma.inviteCode.findUnique({ where: { code } });
      expect(row?.usedCount).toBe(2);
    });
  });
});
