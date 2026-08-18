/**
 * Postgres access.
 *
 * Three things this module exists to enforce:
 *
 *  1. **One pool per container, `max: 1`.** RDS db.t4g.micro allows roughly 85
 *     connections. A warm fleet of Lambda containers each holding a handful would exhaust
 *     that long before CPU became the limit, and the symptom — "the dashboard is down"
 *     during an ingest burst — looks nothing like its cause. The ceiling is enforced by
 *     configuration and documented at the one place it matters.
 *
 *  2. **IAM authentication, signed locally.** `Signer.getAuthToken()` computes a SigV4
 *     token with no network call, so an in-VPC function needs no route to Secrets Manager
 *     to reach the database, and there is no database password anywhere in the deployed
 *     stack. Tokens last 15 minutes, so they are cached and refreshed with a margin.
 *
 *  3. **Parameterised queries only.** `query()` takes a text/values pair. There is no
 *     overload that accepts an interpolated string, so the SQL-injection-shaped mistake is
 *     not expressible through this interface, and `npm run lint` bans template literals
 *     inside `query(` on top of that.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Signer } from '@aws-sdk/rds-signer';
import pg from 'pg';
import type { PoolClient, PoolConfig, QueryResult, QueryResultRow } from 'pg';

import { config } from './config.js';
import { logger } from './logger.js';

/**
 * RDS IAM tokens are valid for 15 minutes. Refreshed at 10 so a connection established
 * just before expiry still has five minutes of validity — a token that expires mid-handshake
 * produces an authentication error that looks like a permissions problem.
 */
const TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * The RDS CA bundle, shipped inside the deployment package. Fetching it at runtime would
 * need internet egress, which the private subnets deliberately do not have; bundling it
 * means certificate verification works with no route out.
 */
const CA_BUNDLE_FILENAME = 'rds-ca-global-bundle.pem';

let poolPromise: Promise<pg.Pool> | undefined;
let cachedToken: { value: string; expiresAt: number } | undefined;
let tokenPromise: Promise<string> | undefined;
let caBundle: string | null | undefined;

function loadCaBundle(): string | null {
  if (caBundle !== undefined) return caBundle;

  // Resolved relative to the bundled handler, which is where the build places the PEM.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, CA_BUNDLE_FILENAME),
    join(here, '..', CA_BUNDLE_FILENAME),
    join(process.cwd(), CA_BUNDLE_FILENAME),
    join(process.cwd(), 'infra', CA_BUNDLE_FILENAME),
  ]) {
    try {
      caBundle = readFileSync(candidate, 'utf8');
      return caBundle;
    } catch {
      // Try the next location.
    }
  }

  caBundle = null;
  return caBundle;
}

async function mintAuthToken(): Promise<string> {
  const signer = new Signer({
    hostname: config.DB_HOST,
    port: config.DB_PORT,
    username: config.DB_USER,
    region: config.AWS_REGION,
  });

  // Local computation — no network call, which is the whole reason this approach removes
  // the need for a NAT gateway or a Secrets Manager round trip in the connection path.
  const value = await signer.getAuthToken();
  cachedToken = { value, expiresAt: Date.now() + TOKEN_TTL_MS };
  return value;
}

/**
 * Called by `pg` for every new connection. The in-flight promise is memoised rather than
 * only the resolved token, so several connections opening at once share one signing pass
 * instead of each doing its own.
 */
function authToken(): Promise<string> {
  const cached = cachedToken;
  if (cached !== undefined && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);

  tokenPromise ??= mintAuthToken().finally(() => {
    tokenPromise = undefined;
  });
  return tokenPromise;
}

function sslConfig(): PoolConfig['ssl'] {
  if (config.DB_SSL_MODE === 'disable') return false;

  if (config.DB_SSL_MODE === 'require') {
    return { rejectUnauthorized: false };
  }

  const ca = loadCaBundle();
  if (ca === null) {
    // Failing closed is the only defensible choice: silently downgrading to an
    // unverified connection is exactly the outcome verify-full was configured to prevent.
    throw new Error(
      `DB_SSL_MODE is verify-full but ${CA_BUNDLE_FILENAME} was not found beside the ` +
        `handler. The build must include it — see backend/scripts/bundle.ts — or set ` +
        `DB_SSL_MODE explicitly for a local database.`,
    );
  }

  return { ca, rejectUnauthorized: true };
}

function poolConfig(): PoolConfig {
  const base: PoolConfig = {
    host: config.DB_HOST,
    port: config.DB_PORT,
    database: config.DB_NAME,
    user: config.DB_USER,
    ssl: sslConfig(),
    max: config.DB_POOL_MAX,

    // Lambda freezes a container between invocations, so an idle connection may be held
    // across minutes of wall time. Reaped after 30s: a frozen container's connection is
    // worthless to anyone and still counts against the instance's limit.
    idleTimeoutMillis: 30_000,

    // Fail fast. A handler blocked on a connection for 30 seconds just burns the
    // invocation's timeout and returns nothing useful.
    connectionTimeoutMillis: 5_000,

    // A backstop against a pathological query holding a connection open. Every real query
    // here is indexed and bounded; 20 seconds means something is wrong, not slow.
    statement_timeout: 20_000,
    query_timeout: 20_000,

    application_name: `worklens-${config.ENVIRONMENT}`,
  };

  if (config.DB_IAM_AUTH) {
    return { ...base, password: authToken };
  }

  return { ...base, password: config.DB_PASSWORD };
}

function createPool(): pg.Pool {
  const created = new pg.Pool(poolConfig());

  // An error on an idle client is emitted on the pool, and an unhandled 'error' event on
  // an EventEmitter terminates the process. Handling it turns a container-killing crash
  // into a logged reconnect.
  created.on('error', (err) => {
    logger.error('idle database client errored', { err });
  });

  return created;
}

export function getPool(): Promise<pg.Pool> {
  poolPromise ??= Promise.resolve(createPool());
  return poolPromise;
}

export interface QuerySpec {
  text: string;
  values?: readonly unknown[];
  /** Appears in slow-query logs. Defaults to the first few words of the SQL. */
  name?: string;
}

function label(spec: QuerySpec): string {
  return spec.name ?? spec.text.trim().split(/\s+/).slice(0, 4).join(' ');
}

/**
 * Runs a parameterised query.
 *
 * There is deliberately no variant taking a plain string: every call site must pass
 * `{ text, values }`, which makes an interpolated query visible in review rather than
 * indistinguishable from a safe one.
 */
export async function query<T extends QueryResultRow>(spec: QuerySpec): Promise<QueryResult<T>> {
  const client = await getPool();
  const started = Date.now();

  try {
    const result = await client.query<T>(spec.text, spec.values as unknown[] | undefined);
    const durationMs = Date.now() - started;

    // 500ms on an indexed query against this data volume means the plan is wrong or a
    // table has grown past its index. Worth a line in the log before it becomes an outage.
    if (durationMs > 500) {
      logger.warn('slow query', { query: label(spec), durationMs, rows: result.rowCount });
    }

    return result;
  } catch (err) {
    // The values are not logged: they contain window titles, employee identifiers, and
    // in the enrolment path a token hash.
    logger.error('query failed', { query: label(spec), err });
    throw err;
  }
}

/** Convenience for the common single-row case. Returns undefined rather than throwing. */
export async function queryOne<T extends QueryResultRow>(
  spec: QuerySpec,
): Promise<T | undefined> {
  const result = await query<T>(spec);
  return result.rows[0];
}

/**
 * Runs `fn` inside a transaction on a dedicated client, committing on return and rolling
 * back on throw.
 *
 * Used where a multi-statement operation must be atomic — consuming an enrolment token and
 * inserting the device, or writing an ingest batch and its events. Note that with
 * `max: 1`, a handler that calls `query()` while inside a transaction would deadlock
 * waiting for itself; every callback here must use the `tx` client it is handed.
 */
export async function transaction<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool();
  const connection = await client.connect();

  try {
    await connection.query('begin');
    const result = await fn(connection);
    await connection.query('commit');
    return result;
  } catch (err) {
    try {
      await connection.query('rollback');
    } catch (rollbackErr) {
      // The original error is the useful one; a failed rollback is worth a line but must
      // not replace it.
      logger.error('rollback failed', { err: rollbackErr });
    }
    throw err;
  } finally {
    connection.release();
  }
}

/**
 * Postgres error codes this codebase reacts to by name rather than by message, since
 * messages are localised and change between versions.
 */
export const PgErrorCode = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
} as const;

export function pgErrorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (pgErrorCode(err) !== PgErrorCode.UNIQUE_VIOLATION) return false;
  if (constraint === undefined) return true;
  const name =
    typeof err === 'object' && err !== null && 'constraint' in err
      ? (err).constraint
      : undefined;
  return name === constraint;
}

export function isCheckViolation(err: unknown, constraint?: string): boolean {
  if (pgErrorCode(err) !== PgErrorCode.CHECK_VIOLATION) return false;
  if (constraint === undefined) return true;
  const name =
    typeof err === 'object' && err !== null && 'constraint' in err
      ? (err).constraint
      : undefined;
  return name === constraint;
}

/**
 * Closes the pool. Not called in Lambda — the container's lifecycle handles it, and
 * closing between invocations would defeat connection reuse — but tests and the migration
 * path need a clean shutdown.
 */
export async function closePool(): Promise<void> {
  const pending = poolPromise;
  if (pending === undefined) return;
  poolPromise = undefined;
  cachedToken = undefined;
  tokenPromise = undefined;
  await (await pending).end();
}
