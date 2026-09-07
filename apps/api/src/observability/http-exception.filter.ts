import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { AppError, codeForStatus, ErrorCode } from './error-codes';
import { ErrorReporter } from './error-reporter';

interface ErrorEnvelope {
  statusCode: number;
  code: ErrorCode;
  message: string;
  requestId: string | null;
  timestamp: string;
  /** Field-level detail from the zod validation pipe, when present. */
  issues?: unknown;
}

/**
 * The one place an error becomes an HTTP response. Every failure leaves the API
 * as `{ statusCode, code, message, requestId, timestamp }` - clients key off
 * `code`. 4xx are logged at `warn`; 5xx (and anything that isn't an
 * `HttpException` - i.e. a bug) are logged at `error`, reported to the
 * {@link ErrorReporter}, and returned with a generic message so internals never
 * leak.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly logger: PinoLogger,
    private readonly reporter: ErrorReporter,
  ) {
    logger.setContext('HttpExceptionFilter');
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    // WebSocket / RPC errors are handled by the gateways themselves.
    if (host.getType() !== 'http') throw exception;

    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();
    const requestId = (req.id as string | undefined) ?? null;

    const { status, code, message, issues, isBug } = this.classify(exception);

    const envelope: ErrorEnvelope = {
      statusCode: status,
      code,
      message,
      requestId,
      timestamp: new Date().toISOString(),
      ...(issues !== undefined ? { issues } : {}),
    };

    const logMeta = {
      code,
      statusCode: status,
      path: req.originalUrl,
      method: req.method,
      requestId,
    };
    if (status >= 500 || isBug) {
      this.logger.error({ ...logMeta, err: exception }, 'request failed');
      this.reporter.capture(exception, {
        scope: 'http',
        requestId: requestId ?? undefined,
        method: req.method,
        path: req.originalUrl,
      });
    } else {
      this.logger.warn(logMeta, message);
    }

    res.status(status).json(envelope);
  }

  private classify(exception: unknown): {
    status: number;
    code: ErrorCode;
    message: string;
    issues?: unknown;
    isBug: boolean;
  } {
    if (exception instanceof AppError) {
      const body = exception.getResponse() as { message?: string };
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: body.message ?? exception.message,
        isBug: false,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      let message: string = exception.message;
      let issues: unknown;
      if (typeof raw === 'string') {
        message = raw;
      } else if (raw && typeof raw === 'object') {
        const obj = raw as { message?: unknown; issues?: unknown };
        if (typeof obj.message === 'string') message = obj.message;
        else if (Array.isArray(obj.message)) message = obj.message.join('; ');
        if (obj.issues !== undefined) issues = obj.issues;
      }
      const code = issues !== undefined ? ErrorCode.VALIDATION_FAILED : codeForStatus(status);
      return { status, code, message, issues, isBug: status >= 500 };
    }

    // Not an HttpException at all - a genuine bug. Do not leak its text.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL,
      message: 'Internal server error',
      isBug: true,
    };
  }
}
