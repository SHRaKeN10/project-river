import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { OrchestrationErrorsService } from '../src/observability/orchestration-errors.service';

/**
 * The error envelope every failure leaves the API as, plus the observability
 * additions to /ops/metrics.
 */
describe('Observability (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: import('http').Server;

  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const admin = { email: `obs_adm_${suffix}@ex.test`, username: `obs_adm_${suffix}`.slice(0, 20) };
  const password = 'a-strong-passphrase';
  let adminToken = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['health/live', 'health/ready'] });
    await app.init();
    await app.listen(0);
    prisma = app.get(PrismaService);
    server = app.getHttpServer();

    await request(server)
      .post('/api/auth/register')
      .send({ ...admin, password });
    await prisma.user.update({ where: { email: admin.email }, data: { role: 'ADMIN' } });
    const login = await request(server)
      .post('/api/auth/login')
      .send({ emailOrUsername: admin.email, password });
    adminToken = login.body.tokens.accessToken;
  }, 30000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: admin.email } }).catch(() => undefined);
    await app?.close();
  });

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('returns the structured error envelope for a 404', async () => {
    const res = await request(server)
      .get('/api/tables/00000000-0000-4000-8000-000000000000')
      .set(auth(adminToken));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: expect.any(String),
      requestId: expect.anything(),
      timestamp: expect.any(String),
    });
  });

  it('returns VALIDATION_FAILED with issues for a bad body', async () => {
    const res = await request(server).post('/api/auth/login').send({ emailOrUsername: 'x' }); // missing password
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(res.body.issues.length).toBeGreaterThan(0);
  });

  it('maps auth failures to UNAUTHORIZED and keeps the human message', async () => {
    const res = await request(server)
      .post('/api/auth/login')
      .send({ emailOrUsername: admin.email, password: 'wrong-passphrase' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
    expect(res.body.message).toBe('Invalid credentials');
  });

  it('gates /api/ops/metrics with FORBIDDEN code for a non-admin', async () => {
    const p = await request(server)
      .post('/api/auth/register')
      .send({
        email: `obs_pl_${suffix}@ex.test`,
        username: `obs_pl_${suffix}`.slice(0, 20),
        password,
      });
    const res = await request(server).get('/api/ops/metrics').set(auth(p.body.tokens.accessToken));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    await prisma.user
      .deleteMany({ where: { email: `obs_pl_${suffix}@ex.test` } })
      .catch(() => undefined);
  });

  it('/ops/metrics carries tournament and orchestration-error blocks', async () => {
    // seed one orchestration error so the counter is exercised end-to-end
    app.get(OrchestrationErrorsService).record('e2e-probe', new Error('synthetic'));

    const res = await request(server).get('/api/ops/metrics').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      tournaments: {
        running: expect.any(Number),
        playersRemaining: expect.any(Number),
        tables: expect.any(Number),
        handsLastMinute: expect.any(Number),
      },
      orchestrationErrors: {
        total: expect.any(Number),
        byScope: expect.objectContaining({ 'e2e-probe': expect.any(Number) }),
        lastMessage: 'synthetic',
        lastAt: expect.any(String),
      },
    });
    expect(res.body.orchestrationErrors.total).toBeGreaterThan(0);
  });
});
