import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infra/prisma/prisma.service';

/**
 * Full auth flow against real Postgres + Redis (docker compose locally, service
 * containers in CI). Requires `prisma migrate deploy` to have run.
 */
describe('Auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `river_${suffix}@example.test`;
  const username = `river_${suffix}`.slice(0, 20);
  const password = 'super-secret-passphrase';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['health/live', 'health/ready'] });
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
    await app?.close();
  });

  const api = () => request(app.getHttpServer());

  it('registers a new user and returns tokens without leaking the password hash', async () => {
    const res = await api().post('/api/auth/register').send({ email, username, password });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email, username, role: 'PLAYER', emailVerified: false });
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect(typeof res.body.tokens.accessToken).toBe('string');
    expect(typeof res.body.tokens.refreshToken).toBe('string');
  });

  it('rejects duplicate registration with 409', async () => {
    const res = await api().post('/api/auth/register').send({ email, username, password });
    expect(res.status).toBe(409);
  });

  it('rejects invalid registration input with 400 and field issues', async () => {
    const res = await api()
      .post('/api/auth/register')
      .send({ email: 'nope', username: 'x', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.issues.length).toBeGreaterThan(0);
  });

  it('logs in with correct credentials and rejects a wrong password', async () => {
    const ok = await api().post('/api/auth/login').send({ emailOrUsername: username, password });
    expect(ok.status).toBe(200);
    expect(ok.body.tokens.accessToken).toBeTruthy();

    const bad = await api()
      .post('/api/auth/login')
      .send({ emailOrUsername: username, password: 'wrong' });
    expect(bad.status).toBe(401);
    expect(bad.body.message).toBe('Invalid credentials');
  });

  it('protects /auth/me and returns the profile with a valid token', async () => {
    const anon = await api().get('/api/auth/me');
    expect(anon.status).toBe(401);

    const login = await api().post('/api/auth/login').send({ emailOrUsername: username, password });
    const me = await api()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${login.body.tokens.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email, username });
  });

  it('rotates refresh tokens and revokes the whole session on reuse', async () => {
    const login = await api().post('/api/auth/login').send({ emailOrUsername: username, password });
    const original = login.body.tokens.refreshToken as string;

    const rotated = await api().post('/api/auth/refresh').send({ refreshToken: original });
    expect(rotated.status).toBe(200);
    const rotatedToken = rotated.body.tokens.refreshToken as string;
    expect(rotatedToken).not.toBe(original);

    // Replaying the now-revoked original token trips reuse detection...
    const reuse = await api().post('/api/auth/refresh').send({ refreshToken: original });
    expect(reuse.status).toBe(401);

    // ...and that kills the session, so even the freshly-rotated token is dead.
    const afterKill = await api().post('/api/auth/refresh').send({ refreshToken: rotatedToken });
    expect(afterKill.status).toBe(401);

    const events = await prisma.auditLog.findMany({
      where: { action: 'REFRESH_TOKEN_REUSE_DETECTED' },
    });
    expect(events.length).toBeGreaterThan(0);
  });

  it('logout revokes the session so neither its refresh nor its access token still works', async () => {
    const login = await api().post('/api/auth/login').send({ emailOrUsername: username, password });
    const { accessToken, refreshToken } = login.body.tokens;

    // the access token works right now
    expect(
      (await api().get('/api/auth/me').set('Authorization', `Bearer ${accessToken}`)).status,
    ).toBe(200);

    const out = await api().post('/api/auth/logout').set('Authorization', `Bearer ${accessToken}`);
    expect(out.status).toBe(204);

    const refresh = await api().post('/api/auth/refresh').send({ refreshToken });
    expect(refresh.status).toBe(401);

    // the still-unexpired access token is now denylisted too
    const me = await api().get('/api/auth/me').set('Authorization', `Bearer ${accessToken}`);
    expect(me.status).toBe(401);
  });

  it('password-reset request returns 202 whether or not the email exists', async () => {
    const existing = await api().post('/api/auth/password-reset/request').send({ email });
    const missing = await api()
      .post('/api/auth/password-reset/request')
      .send({ email: `ghost_${suffix}@example.test` });
    expect(existing.status).toBe(202);
    expect(missing.status).toBe(202);
    // In prod both bodies are identical (empty). In dev/test the existing-user
    // response carries a devToken so the flow can be exercised without email.
    expect(missing.body).toEqual({});
  });

  it('completes a password reset, kills old sessions, and accepts the new password', async () => {
    const login = await api().post('/api/auth/login').send({ emailOrUsername: username, password });
    const staleRefresh = login.body.tokens.refreshToken as string;
    const staleAccess = login.body.tokens.accessToken as string;

    const reqRes = await api().post('/api/auth/password-reset/request').send({ email });
    const devToken = reqRes.body.devToken as string;
    expect(devToken).toBeTruthy();

    const newPassword = 'an-entirely-different-passphrase';
    const confirm = await api()
      .post('/api/auth/password-reset/confirm')
      .send({ token: devToken, newPassword });
    expect(confirm.status).toBe(204);

    // token is single-use
    const replay = await api()
      .post('/api/auth/password-reset/confirm')
      .send({ token: devToken, newPassword });
    expect(replay.status).toBe(401);

    // every pre-reset session is dead - refresh and access alike
    expect(
      (await api().post('/api/auth/refresh').send({ refreshToken: staleRefresh })).status,
    ).toBe(401);
    expect(
      (await api().get('/api/auth/me').set('Authorization', `Bearer ${staleAccess}`)).status,
    ).toBe(401);

    // old password no longer works, new one does
    expect(
      (await api().post('/api/auth/login').send({ emailOrUsername: username, password })).status,
    ).toBe(401);
    expect(
      (
        await api()
          .post('/api/auth/login')
          .send({ emailOrUsername: username, password: newPassword })
      ).status,
    ).toBe(200);
  });

  it('verifies an email address via the token flow', async () => {
    const vEmail = `verify_${suffix}@example.test`;
    const vUser = `verify_${suffix}`.slice(0, 20);
    const reg = await api()
      .post('/api/auth/register')
      .send({ email: vEmail, username: vUser, password });
    const accessToken = reg.body.tokens.accessToken as string;
    expect(reg.body.user.emailVerified).toBe(false);

    const reqRes = await api()
      .post('/api/auth/email-verification/request')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(reqRes.status).toBe(202);
    const devToken = reqRes.body.devToken as string;
    expect(devToken).toBeTruthy();

    const confirm = await api()
      .post('/api/auth/email-verification/confirm')
      .send({ token: devToken });
    expect(confirm.status).toBe(204);

    const me = await api().get('/api/auth/me').set('Authorization', `Bearer ${accessToken}`);
    expect(me.body.emailVerified).toBe(true);

    await prisma.user.deleteMany({ where: { email: vEmail } }).catch(() => undefined);
  });
});
