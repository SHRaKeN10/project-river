import { Test } from '@nestjs/testing';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { PrismaService } from '../infra/prisma/prisma.service';
import { RedisService } from '../infra/redis/redis.service';

describe('HealthController', () => {
  let controller: HealthController;
  const prisma = { ping: jest.fn().mockResolvedValue(undefined) };
  const redis = { ping: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TerminusModule],
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();
    controller = moduleRef.get(HealthController);
  });

  it('live() returns ok', () => {
    expect(controller.live()).toEqual({ status: 'ok' });
  });

  it('ready() reports database and redis up', async () => {
    const result = await controller.ready();
    expect(result.status).toBe('ok');
    expect(result.info).toMatchObject({ database: { status: 'up' }, redis: { status: 'up' } });
  });
});
