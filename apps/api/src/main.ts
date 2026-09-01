import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));
  app.flushLogs();

  const config = app.get(AppConfigService);

  // Health endpoints stay unprefixed for infra probes; everything else is /api/*.
  app.setGlobalPrefix('api', { exclude: ['health/live', 'health/ready'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();

  const origins = config.get('CORS_ORIGINS');
  app.enableCors({ origin: origins.length ? origins : true, credentials: true });

  const port = config.get('PORT');
  await app.listen(port);
  app.get(Logger).log(`API listening on http://localhost:${port} (${config.get('NODE_ENV')})`);
}

void bootstrap();
