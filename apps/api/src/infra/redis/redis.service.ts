import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../../config/app-config.service';

/**
 * Owns the primary Redis connection. Additional dedicated connections (e.g. the
 * Socket.IO adapter's pub/sub pair) are created via `duplicate()`.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(config: AppConfigService) {
    this.client = new Redis(config.get('REDIS_URL'), {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });
    this.client.on('error', (err) => this.logger.error(`Redis error: ${err.message}`));
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
    this.logger.log('Redis connected');
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }

  duplicate(): Redis {
    return this.client.duplicate();
  }

  async ping(): Promise<void> {
    const res = await this.client.ping();
    if (res !== 'PONG') throw new Error(`Unexpected Redis PING response: ${res}`);
  }
}
