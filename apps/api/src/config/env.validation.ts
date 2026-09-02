import { z } from 'zod';

/** Fail fast on boot if the environment is misconfigured. */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),

    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),

    JWT_ACCESS_SECRET: z.string().min(16),
    JWT_REFRESH_SECRET: z.string().min(16),
    JWT_ACCESS_TTL: z.coerce.number().int().positive().default(600),
    JWT_REFRESH_TTL: z.coerce.number().int().positive().default(2_592_000),

    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),

    /** Poker table timing (ms). Kept low in tests. */
    TABLE_ACTION_TIMEOUT_MS: z.coerce.number().int().positive().default(25_000),
    TABLE_NEXT_HAND_DELAY_MS: z.coerce.number().int().nonnegative().default(4_000),
    TABLE_START_DELAY_MS: z.coerce.number().int().nonnegative().default(3_000),
    /** Shorter clock for a player whose socket is gone: their turn auto-resolves
     * this fast instead of waiting out the full action timeout. */
    TABLE_DISCONNECT_GRACE_MS: z.coerce.number().int().positive().default(10_000),
    /** A seated player who has been disconnected this long is stood up (seat
     * freed, stack returned to their wallet). */
    TABLE_AWAY_MAX_MS: z.coerce.number().int().positive().default(120_000),
    /** ...or once they have missed this many hands while away, whichever first. */
    TABLE_AWAY_MAX_MISSED_HANDS: z.coerce.number().int().positive().default(10),
  })
  .superRefine((env, ctx) => {
    // Outside dev/test the browser client is served from a real origin, so an
    // explicit allow-list is mandatory - `origin: true` (reflect any origin)
    // must never reach staging/production.
    if (
      (env.NODE_ENV === 'staging' || env.NODE_ENV === 'production') &&
      env.CORS_ORIGINS.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message: `CORS_ORIGINS must list at least one origin when NODE_ENV=${env.NODE_ENV}`,
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
