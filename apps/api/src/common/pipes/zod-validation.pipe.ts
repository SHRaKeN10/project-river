import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Validates (and transforms) a request body/param against a zod schema from
 * @river/shared-types. Use per-route: `@Body(new ZodValidationPipe(loginSchema))`.
 * The project validates with zod, not class-validator - so the two must never
 * disagree, and the client can reuse the exact same schema.
 */
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    return result.data;
  }
}
