import { z } from 'zod';

const BaseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  MONGO_URI: z.string().min(1),
  MONGO_DB: z.string().min(1),
  MONGO_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  // Batch jobs (bulk DO/shipment create, imports) run one `withTransaction` for the whole batch;
  // the per-request `MONGO_TIMEOUT_MS` budget is too tight for that, so they use this larger
  // budget instead (spec §13.2: "API queries ... maxTimeMS 1000ms (batch jobs 30000ms)").
  MONGO_BATCH_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  MONGO_MAX_POOL_SIZE: z.coerce.number().int().positive().default(20),
  JWT_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(3600),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  REFRESH_REUSE_GRACE_SEC: z.coerce.number().int().min(0).default(30),
  API_KEY_PEPPER: z.string().min(16),
  LOGIN_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(10),
  // Passed straight to Fastify's `trustProxy` option. 'false' (default) trusts nothing;
  // 'true' trusts the immediate peer's X-Forwarded-For chain unconditionally; a positive
  // integer is the number of proxy hops to trust (set this on Render, see README).
  TRUST_PROXY: z
    .string()
    .default('false')
    .refine((v) => v === 'true' || v === 'false' || /^[1-9]\d*$/.test(v), {
      message: 'TRUST_PROXY must be "true", "false", or a positive integer hop count',
    }),
  STORAGE_DRIVER: z.enum(['s3', 'memory']).default('memory'),
  SPACES_ENDPOINT: z.string().url().optional(),
  SPACES_REGION: z.string().default('sgp1'),
  SPACES_BUCKET: z.string().min(1).optional(),
  SPACES_KEY: z.string().min(1).optional(),
  SPACES_SECRET: z.string().min(1).optional(),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
});

const EnvSchema = BaseEnvSchema.superRefine((env, ctx) => {
  if (env.STORAGE_DRIVER !== 's3') return;
  for (const k of ['SPACES_ENDPOINT', 'SPACES_BUCKET', 'SPACES_KEY', 'SPACES_SECRET'] as const) {
    if (!env[k]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: `${k} is required when STORAGE_DRIVER=s3` });
  }
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}
