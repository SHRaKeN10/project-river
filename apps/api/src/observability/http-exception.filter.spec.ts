import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AntiRatholeCooldownError, ErrorCode } from './error-codes';
import { ErrorContext, ErrorReporter } from './error-reporter';
import { HttpExceptionFilter } from './http-exception.filter';

class FakeReporter extends ErrorReporter {
  calls: Array<{ error: unknown; context: ErrorContext }> = [];
  capture(error: unknown, context: ErrorContext): void {
    this.calls.push({ error, context });
  }
}

function hostFor(req: Record<string, unknown>): {
  host: ArgumentsHost;
  sent: { status?: number; body?: unknown };
} {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
  };
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  } as unknown as ArgumentsHost;
  return { host, sent };
}

describe('HttpExceptionFilter', () => {
  const logger = { setContext: jest.fn(), error: jest.fn(), warn: jest.fn() };
  let reporter: FakeReporter;
  let filter: HttpExceptionFilter;

  beforeEach(() => {
    jest.clearAllMocks();
    reporter = new FakeReporter();
    filter = new HttpExceptionFilter(logger as never, reporter);
  });

  const baseReq = { id: 'req-123', originalUrl: '/api/x', method: 'POST' };

  it('wraps a NotFoundException in the envelope with a mapped code', () => {
    const { host, sent } = hostFor(baseReq);
    filter.catch(new NotFoundException('table not found'), host);

    expect(sent.status).toBe(404);
    expect(sent.body).toEqual({
      statusCode: 404,
      code: ErrorCode.NOT_FOUND,
      message: 'table not found',
      requestId: 'req-123',
      timestamp: expect.any(String),
    });
    expect(logger.warn).toHaveBeenCalled();
    expect(reporter.calls).toHaveLength(0); // 4xx is not reported
  });

  it('carries an AppError code straight through', () => {
    const { host, sent } = hostFor(baseReq);
    filter.catch(new AntiRatholeCooldownError('come back with at least 5000'), host);

    expect(sent.status).toBe(400);
    expect(sent.body).toMatchObject({
      code: ErrorCode.ANTI_RATHOLE_COOLDOWN,
      message: 'come back with at least 5000',
    });
  });

  it('preserves zod validation issues and tags the code', () => {
    const { host, sent } = hostFor(baseReq);
    filter.catch(
      new BadRequestException({
        message: 'Validation failed',
        issues: [{ path: 'email', message: 'required' }],
      }),
      host,
    );

    expect(sent.body).toMatchObject({
      code: ErrorCode.VALIDATION_FAILED,
      message: 'Validation failed',
      issues: [{ path: 'email', message: 'required' }],
    });
  });

  it('does not leak internals for a non-HttpException, and reports it', () => {
    const { host, sent } = hostFor(baseReq);
    filter.catch(new Error('connect ECONNREFUSED 10.0.0.1:5432'), host);

    expect(sent.status).toBe(500);
    expect(sent.body).toMatchObject({
      code: ErrorCode.INTERNAL,
      message: 'Internal server error',
    });
    expect(logger.error).toHaveBeenCalled();
    expect(reporter.calls).toHaveLength(1);
    expect(reporter.calls[0].context).toMatchObject({ scope: 'http', path: '/api/x' });
  });

  it('reports a thrown 5xx HttpException', () => {
    const { host } = hostFor(baseReq);
    filter.catch(new ForbiddenException(), host); // 403 - not reported
    expect(reporter.calls).toHaveLength(0);
  });

  it('handles a missing request id', () => {
    const { host, sent } = hostFor({ originalUrl: '/api/y', method: 'GET' });
    filter.catch(new NotFoundException(), host);
    expect((sent.body as { requestId: unknown }).requestId).toBeNull();
  });

  it('re-throws non-http (ws/rpc) contexts', () => {
    const wsHost = { getType: () => 'ws' } as unknown as ArgumentsHost;
    const err = new Error('ws');
    expect(() => filter.catch(err, wsHost)).toThrow(err);
  });
});
