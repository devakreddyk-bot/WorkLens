/**
 * Environment configuration, validated once at module load.
 *
 * Parsing at load rather than at first use is deliberate: a function with a missing or
 * malformed environment variable fails on its very first invocation with a message that
 * names the variable, instead of throwing something obscure from deep inside a handler
 * on whichever request happens to reach that line first. In Lambda that means the
 * failure shows up on deploy, not at 2 a.m.
 *
 * Only variables the handlers actually read live here. Terraform sets them; every one is
 * documented in backend/.env.example.
 */

import { z } from 'zod';

/** A positive integer supplied as a string, as all Lambda environment variables are. */
const intFromEnv = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/, 'must be a whole number')
    .transform(Number)
    .refine((n) => n >= min && n <= max, `must be between ${min} and ${max}`);

const boolFromEnv = z
  .enum(['0', '1', 'true', 'false'])
  .transform((v) => v === '1' || v === 'true');

const schema = z.object({
  // --- runtime ---
  ENVIRONMENT: z.string().min(1).default('prod'),
  AWS_REGION: z.string().min(1),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /**
   * Off by default and must stay off in production: request bodies contain window and
   * page titles, which are personal data. Logging them copies that data into CloudWatch
   * under a different retention policy than the database.
   */
  LOG_REQUEST_BODIES: boolFromEnv.default('0'),

  // --- database ---
  DB_HOST: z.string().min(1),
  DB_PORT: intFromEnv(1, 65535).default('5432'),
  DB_NAME: z.string().min(1),
  DB_USER: z.string().min(1),
  /**
   * When true the pool signs a short-lived RDS IAM token per connection instead of using
   * a password. This is how the deployed stack authenticates; there is no database
   * password anywhere in it.
   */
  DB_IAM_AUTH: boolFromEnv.default('1'),
  /** Local development only. Ignored when DB_IAM_AUTH is true. */
  DB_PASSWORD: z.string().optional(),
  DB_SSL_MODE: z.enum(['disable', 'require', 'verify-full']).default('verify-full'),
  /**
   * Keep at 1. RDS db.t4g.micro allows roughly 85 connections; a warm fleet of Lambda
   * containers each holding several would exhaust that long before CPU became the limit.
   * Raise it only behind RDS Proxy.
   */
  DB_POOL_MAX: intFromEnv(1, 20).default('1'),

  // --- device credentials ---
  DEVICE_ROOT_KEY_SECRET_ARN: z.string().min(1).optional(),
  /**
   * Accepted clock skew for signed agent requests. Must stay well below the nonce sweep
   * retention interval, or a replay becomes possible at the window boundary.
   */
  HMAC_TIMESTAMP_SKEW_SECONDS: intFromEnv(30, 900).default('300'),
  NONCE_RETENTION_SECONDS: intFromEnv(600, 86400).default('600'),

  // --- ingest limits ---
  MAX_EVENTS_PER_BATCH: intFromEnv(1, 5000).default('500'),
  INGEST_MAX_BODY_BYTES: intFromEnv(1024, 10 * 1024 * 1024).default('1048576'),
  DEVICE_QUOTA_EVENTS_PER_WINDOW: intFromEnv(100, 1_000_000).default('5000'),
  DEVICE_QUOTA_WINDOW_SECONDS: intFromEnv(60, 86400).default('3600'),

  // --- screenshots ---
  SCREENSHOT_BUCKET: z.string().optional(),
  SCREENSHOT_PREFIX: z.string().default('screenshots/'),
  S3_KMS_KEY_ARN: z.string().optional(),
  PRESIGN_EXPIRY_SECONDS: intFromEnv(60, 3600).default('900'),
  PRESIGN_VIEW_EXPIRY_SECONDS: intFromEnv(30, 3600).default('300'),
  MAX_SCREENSHOT_BYTES: intFromEnv(1024, 20 * 1024 * 1024).default('5242880'),

  // --- aggregation ---
  AGGREGATION_LOOKBACK_DAYS: intFromEnv(1, 31).default('3'),
  AGGREGATION_REGEX_BUDGET_MS: intFromEnv(1, 1000).default('5'),

  // --- auth ---
  COGNITO_USER_POOL_ID: z.string().optional(),
  COGNITO_CLIENT_ID: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

function parseConfig(env: NodeJS.ProcessEnv): Config {
  const result = schema.safeParse(env);

  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const name = issue.path.join('.');
      return `  ${name}: ${issue.message}`;
    });
    throw new Error(
      `Invalid environment configuration:\n${lines.join('\n')}\n\n` +
        `Every variable is documented in backend/.env.example. In AWS these are set by ` +
        `Terraform (infra/modules/lambda), so a failure here usually means a variable was ` +
        `added to the code without being added to the module.`,
    );
  }

  const config = result.data;

  // Cross-field rules Zod cannot express field-by-field.
  if (!config.DB_IAM_AUTH && (config.DB_PASSWORD === undefined || config.DB_PASSWORD === '')) {
    throw new Error(
      'DB_IAM_AUTH is false but DB_PASSWORD is not set. Set one or the other: IAM ' +
        'authentication for the deployed stack, a password for a local database.',
    );
  }

  if (config.NONCE_RETENTION_SECONDS <= config.HMAC_TIMESTAMP_SKEW_SECONDS) {
    throw new Error(
      `NONCE_RETENTION_SECONDS (${config.NONCE_RETENTION_SECONDS}) must exceed ` +
        `HMAC_TIMESTAMP_SKEW_SECONDS (${config.HMAC_TIMESTAMP_SKEW_SECONDS}). Nonces are ` +
        `what stops a captured request being replayed; expiring them sooner than the ` +
        `window in which a timestamp is still accepted reopens exactly that hole.`,
    );
  }

  if (config.ENVIRONMENT === 'prod' && config.LOG_REQUEST_BODIES) {
    throw new Error(
      'LOG_REQUEST_BODIES must not be enabled in production. Request bodies contain ' +
        'window and page titles, which are personal data, and CloudWatch retention is ' +
        'not the retention policy the organisation configured for activity data.',
    );
  }

  return config;
}

/** Exported for tests, which need to assert the validation rules above actually fire. */
export { parseConfig, schema as configSchema };

export const config: Config = parseConfig(process.env);

/**
 * Reads a variable that is optional in the schema but mandatory for the handler asking.
 * Screenshot handlers need the bucket; the config handler does not, and giving every
 * function every variable would mean a typo in one breaks all of them.
 */
export function requireConfig<K extends keyof Config>(key: K): NonNullable<Config[K]> {
  const value = config[key];
  if (value === undefined || value === '') {
    throw new Error(
      `${String(key)} is required by this handler but is not set. Check that ` +
        `infra/modules/lambda passes it to this function.`,
    );
  }
  return value;
}
