import { Injectable } from '@nestjs/common';
import { ErrorReporter } from './error-reporter';

/**
 * Where the table / tournament coordinators send failures that happen *outside*
 * a request - a broken async handler, a checkpoint write that threw, a listener
 * that blew up. These never reach the HTTP filter, so without this they would
 * only ever be a log line. Here they are logged, reported, and counted so
 * `/ops/metrics` can surface "the coordinators are unhappy" at a glance.
 */
@Injectable()
export class OrchestrationErrorsService {
  private total = 0;
  private readonly byScope = new Map<string, number>();
  private lastMessage: string | null = null;
  private lastAt: number | null = null;

  constructor(private readonly reporter: ErrorReporter) {}

  record(scope: string, error: unknown, detail: Record<string, unknown> = {}): void {
    this.total += 1;
    this.byScope.set(scope, (this.byScope.get(scope) ?? 0) + 1);
    this.lastMessage = error instanceof Error ? error.message : String(error);
    this.lastAt = Date.now();
    this.reporter.capture(error, { scope, ...detail });
  }

  snapshot(): {
    total: number;
    byScope: Record<string, number>;
    lastMessage: string | null;
    lastAt: string | null;
  } {
    return {
      total: this.total,
      byScope: Object.fromEntries(this.byScope),
      lastMessage: this.lastMessage,
      lastAt: this.lastAt ? new Date(this.lastAt).toISOString() : null,
    };
  }
}
