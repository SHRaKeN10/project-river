import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe';

describe('ZodValidationPipe', () => {
  const schema = z.object({ email: z.string().email(), age: z.coerce.number().int().positive() });

  it('returns the parsed (possibly coerced) value on success', () => {
    const pipe = new ZodValidationPipe(schema);
    const result = pipe.transform({ email: 'a@b.com', age: '5' });
    expect(result).toEqual({ email: 'a@b.com', age: 5 });
  });

  it('throws BadRequestException with per-field issues on failure', () => {
    const pipe = new ZodValidationPipe(schema);
    try {
      pipe.transform({ email: 'not-an-email', age: -1 });
      fail('expected transform to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const response = (err as BadRequestException).getResponse() as {
        issues: Array<{ path: string }>;
      };
      const paths = response.issues.map((i) => i.path);
      expect(paths).toEqual(expect.arrayContaining(['email', 'age']));
    }
  });
});
