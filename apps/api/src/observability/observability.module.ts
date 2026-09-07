import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppConfigService } from '../config/app-config.service';
import { ErrorReporter, LoggingErrorReporter } from './error-reporter';
import { HttpExceptionFilter } from './http-exception.filter';
import { OrchestrationErrorsService } from './orchestration-errors.service';
import { SentryErrorReporter } from './sentry.reporter';

/**
 * Cross-cutting error handling: the global HTTP exception filter, the
 * {@link ErrorReporter} seam (structured logs always, Sentry when `SENTRY_DSN`
 * is set), and the {@link OrchestrationErrorsService} counter. Global so the
 * coordinators and services can inject the reporter/counter directly.
 */
@Global()
@Module({
  providers: [
    {
      provide: ErrorReporter,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        config.get('SENTRY_DSN') ? new SentryErrorReporter() : new LoggingErrorReporter(),
    },
    OrchestrationErrorsService,
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
  exports: [ErrorReporter, OrchestrationErrorsService],
})
export class ObservabilityModule {}
