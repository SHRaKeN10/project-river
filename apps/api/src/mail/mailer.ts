import { Logger } from '@nestjs/common';

export interface OutgoingEmail {
  to: string;
  subject: string;
  /** Plain-text body. Alpha email is text-only on purpose - no HTML templates. */
  text: string;
}

/**
 * The seam between "the app wants to send an email" and an email provider.
 * {@link ConsoleMailer} is the default (dev, tests, and prod until a key is
 * set) and only logs. {@link ResendMailer} posts to Resend when
 * `RESEND_API_KEY` is configured. See ADR-0034.
 */
export abstract class Mailer {
  abstract send(email: OutgoingEmail): Promise<void>;
}

export class ConsoleMailer extends Mailer {
  private readonly logger = new Logger('Mailer');

  async send(email: OutgoingEmail): Promise<void> {
    // The body carries the reset token in dev/test - debug level only.
    this.logger.log({ event: 'email_skipped', reason: 'no RESEND_API_KEY', to: email.to });
    this.logger.debug(`--- ${email.subject} -> ${email.to} ---\n${email.text}`);
  }
}

export class ResendMailer extends Mailer {
  private readonly logger = new Logger('Mailer');

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {
    super();
  }

  async send(email: OutgoingEmail): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: email.to,
        subject: email.subject,
        text: email.text,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Resend responded ${res.status}: ${detail.slice(0, 300)}`);
    }
    this.logger.log({ event: 'email_sent', to: email.to, subject: email.subject });
  }
}
