import { Global, Module } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { ConsoleMailer, Mailer, ResendMailer } from './mailer';

/**
 * The {@link Mailer} seam. `RESEND_API_KEY` present => real sends via Resend;
 * otherwise a console-only mailer (dev, tests, and prod until the key is set).
 * Global so any service can inject `Mailer` directly. See ADR-0034.
 */
@Global()
@Module({
  providers: [
    {
      provide: Mailer,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): Mailer => {
        const key = config.get('RESEND_API_KEY');
        return key ? new ResendMailer(key, config.get('MAIL_FROM')) : new ConsoleMailer();
      },
    },
  ],
  exports: [Mailer],
})
export class MailModule {}
