import './observability/instrument';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import { ErrorReporter } from './observability/error-reporter';
import { Sentry } from './observability/instrument';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));
  app.flushLogs();

  const config = app.get(AppConfigService);
  const log = app.get(Logger);
  const reporter = app.get(ErrorReporter);

  // Last-resort process guards. A rejected promise or a throw that escapes every
  // handler is a bug we must see; an uncaught exception also leaves the process
  // in an unknown state, so we flush and exit and let Fly restart it clean
  // (restart recovery is covered by the Redis snapshot - see ADR-0025).
  process.on('unhandledRejection', (reason) => {
    reporter.capture(reason, { scope: 'unhandledRejection' });
  });
  process.on('uncaughtException', (err) => {
    reporter.capture(err, { scope: 'uncaughtException' });
    void Sentry.flush(2000).finally(() => process.exit(1));
  });

  // Health endpoints stay unprefixed for infra probes; everything else is /api/*.
  app.setGlobalPrefix('api', { exclude: ['health/live', 'health/ready'] });
  // Request validation is added in Phase 2 as a zod-based pipe (the project
  // validates with zod schemas from @river/shared-types, not class-validator).
  app.enableShutdownHooks();

  const origins = config.get('CORS_ORIGINS');
  app.enableCors({ origin: origins.length ? origins : true, credentials: true });

  const port = config.get('PORT');
  await app.listen(port, '0.0.0.0');
  log.log(
    `API listening on :${port} (${config.get('NODE_ENV')}) · cors=${
      origins.length ? origins.join(',') : 'reflect-any'
    } · sentry=${config.get('SENTRY_DSN') ? 'on' : 'off'}`,
  );
}

void bootstrap();
