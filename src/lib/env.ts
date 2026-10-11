import { z } from 'zod';

/**
 * Server-side environment contract (spec §78, §102, §134).
 *
 * Rules enforced here:
 *  - Secrets are read ONLY on the server. Nothing here is NEXT_PUBLIC_*, so none of
 *    these values can be inlined into a browser bundle.
 *  - Development may run with zero credentials configured (the app degrades to honest
 *    "not configured" states). Production must fail fast instead of silently degrading.
 */

const serverSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['development', 'preview', 'production']).default('development'),
  APP_URL: z.string().min(1).default('http://localhost:3000'),

  // ---- Database (spec §2, §102) -------------------------------------------------
  // 'auto'     : use DATABASE_URL when present, else the embedded PGlite instance.
  // 'pglite'   : force the embedded real-Postgres (WASM) instance.
  // 'postgres' : force DATABASE_URL and fail if it is missing.
  DB_SUBSTRATE: z.enum(['auto', 'pglite', 'postgres']).default('auto'),
  DATABASE_URL: z.string().min(1).optional(),
  PGLITE_DATA_DIR: z.string().min(1).default('.data/pglite'),
  // PGlite is single-writer (verified by the environment probe), so dev/worker
  // processes share one instance through this in-process guard rather than opening
  // the data directory twice.
  DB_POOL_SIZE: z.coerce.number().int().positive().default(4),

  // ---- Sessions (spec §76) ------------------------------------------------------
  SESSION_SECRET: z.string().min(32).optional(),

  // ---- Storage (spec §58, §77) --------------------------------------------------
  STORAGE_DIR: z.string().min(1).default('.data/storage'),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 1024 * 1024),

  // ---- AI providers (spec §3, §18, §100, §111) ----------------------------------
  // All optional. When absent the corresponding feature reports `not_configured`
  // instead of inventing data (spec §68, §136).
  AI_VISION_PROVIDER: z.enum(['openai', 'none']).default('none'),
  AI_VISION_MODEL: z.string().min(1).default('gpt-4o-mini'),
  AI_LLM_PROVIDER: z.enum(['openai', 'none']).default('none'),
  AI_LLM_MODEL: z.string().min(1).default('gpt-4o-mini'),
  AI_STT_PROVIDER: z.enum(['openai', 'none']).default('none'),
  AI_STT_MODEL: z.string().min(1).default('whisper-1'),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_BASE_URL: z.string().min(1).default('https://api.openai.com/v1'),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),

  // ---- Nutrition data provider (spec §11, §16) ----------------------------------
  NUTRITION_PROVIDER: z.enum(['local', 'openfoodfacts']).default('local'),
  OPENFOODFACTS_BASE_URL: z.string().min(1).default('https://world.openfoodfacts.org'),

  // ---- Payments (spec §72, §73) -------------------------------------------------
  PAYMENT_PROVIDER: z.enum(['none', 'sandbox', 'stripe', 'razorpay']).default('none'),
  PAYMENT_SECRET_KEY: z.string().min(1).optional(),
  PAYMENT_WEBHOOK_SECRET: z.string().min(1).optional(),
  PAYMENT_CURRENCY: z.string().length(3).default('INR'),

  // ---- Observability (spec §81) -------------------------------------------------
  SENTRY_DSN: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // ---- Analytics (spec §83) -----------------------------------------------------
  ANALYTICS_ENABLED: z.enum(['true', 'false']).default('true'),
});

export type ServerEnv = z.infer<typeof serverSchema>;

function readRawEnv(): Record<string, string | undefined> {
  const raw: Record<string, string | undefined> = {};
  for (const key of Object.keys(serverSchema.shape)) {
    const value = process.env[key];
    if (value !== undefined && value !== '') raw[key] = value;
  }
  return raw;
}

function parseEnv(): ServerEnv {
  const parsed = serverSchema.safeParse(readRawEnv());
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid server environment:\n${issues}`);
  }
  return parsed.data;
}

let cached: ServerEnv | undefined;

/** Parsed, validated server environment. Never import this from a client component. */
export function env(): ServerEnv {
  cached ??= parseEnv();
  return cached;
}

/** True when the process is running the production configuration (spec §102). */
export function isProduction(): boolean {
  return env().APP_ENV === 'production' || env().NODE_ENV === 'production';
}

/**
 * Production guard rails (spec §78, §102).
 *
 * Returns the list of settings that are unsafe or missing in production. The app calls
 * this during boot so a misconfigured production deployment fails loudly instead of
 * quietly serving a degraded or insecure system.
 */
export function productionReadinessProblems(): string[] {
  const e = env();
  if (!isProduction()) return [];

  const problems: string[] = [];
  if (!e.SESSION_SECRET) problems.push('SESSION_SECRET is required in production.');
  if (e.DB_SUBSTRATE === 'postgres' && !e.DATABASE_URL) {
    problems.push('DB_SUBSTRATE=postgres requires DATABASE_URL.');
  }
  if (e.DB_SUBSTRATE === 'pglite') {
    problems.push(
      'DB_SUBSTRATE=pglite uses an embedded single-process database; use a real ' +
        'PostgreSQL server (DB_SUBSTRATE=postgres) in production.',
    );
  }
  if (e.PAYMENT_PROVIDER === 'sandbox') {
    problems.push('PAYMENT_PROVIDER=sandbox must not be used in production.');
  }
  if (e.PAYMENT_PROVIDER !== 'none' && e.PAYMENT_PROVIDER !== 'sandbox') {
    if (!e.PAYMENT_SECRET_KEY)
      problems.push('PAYMENT_SECRET_KEY is required for the payment provider.');
    if (!e.PAYMENT_WEBHOOK_SECRET) {
      problems.push('PAYMENT_WEBHOOK_SECRET is required to verify webhook signatures.');
    }
  }
  if (e.AI_VISION_PROVIDER !== 'none' && !e.OPENAI_API_KEY) {
    problems.push('AI_VISION_PROVIDER is set but OPENAI_API_KEY is missing.');
  }
  if (e.AI_LLM_PROVIDER !== 'none' && !e.OPENAI_API_KEY) {
    problems.push('AI_LLM_PROVIDER is set but OPENAI_API_KEY is missing.');
  }
  return problems;
}

/**
 * Guard against the classic leak: a server secret accidentally referenced from client
 * code. Only names are reported, never values.
 */
export function assertNoServerSecretsInClientBundle(keys: readonly string[]): string[] {
  const secrets = [
    'OPENAI_API_KEY',
    'DATABASE_URL',
    'SESSION_SECRET',
    'PAYMENT_SECRET_KEY',
    'PAYMENT_WEBHOOK_SECRET',
    'SENTRY_DSN',
  ];
  return keys.filter((key) => secrets.includes(key));
}
