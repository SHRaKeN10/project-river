import 'reflect-metadata';
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
  // Request validation is added in Phase 2 as a zod-based pipe (the project
  // validates with zod schemas from @river/shared-types, not class-validator).
  app.enableShutdownHooks();

  const origins = config.get('CORS_ORIGINS');
  app.enableCors({ origin: origins.length ? origins : true, credentials: true });

  const port = config.get('PORT');
  await app.listen(port, '0.0.0.0');
  app
    .get(Logger)
    .log(
      `API listening on :${port} (${config.get('NODE_ENV')}) · cors=${
        origins.length ? origins.join(',') : 'reflect-any'
      }`,
    );
}

void bootstrap();
