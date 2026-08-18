/**
 * Applies database migrations from inside the VPC.
 *
 * **This is the only way migrations reach the deployed database.** RDS sits in a private
 * subnet with `publicly_accessible = false` and a security group that admits only the
 * Lambda security group, so no laptop, CI runner or bastion-less operator can connect. The
 * alternatives were a bastion host (a permanently reachable box holding database access) or
 * making the database public (no). A short-lived function inside the VPC is neither.
 *
 * Invoke it directly — it is not behind the API:
 *
 *     aws lambda invoke --function-name worklens-prod-db-migrate \
 *       --payload '{}' /dev/stdout
 *     aws lambda invoke --function-name worklens-prod-db-migrate \
 *       --payload '{"action":"status"}' /dev/stdout
 *
 * ## Two things that make this different from the CLI
 *
 * **The SQL is embedded, not read from disk.** The `.sql` files are imported as strings and
 * bundled into the deployment package by esbuild's text loader (see
 * `backend/scripts/bundle.ts`). A Lambda has no repository to read from, and shipping the
 * schema separately — in S3, say — would let the code and the migrations it expects drift
 * apart between deploys. Bundled together, a function version and its migration set are one
 * artifact.
 *
 * The consequence to know about: **adding a migration file means adding it to the list
 * below.** That is deliberate. An implicit glob would silently ship whatever happened to be
 * in the directory, and there is no import-time glob in ESM anyway. `assertAllMigrationsBundled`
 * turns a forgotten entry into a loud failure rather than a silently skipped migration.
 *
 * **It connects as the master user, not `worklens_app`.** Migration 0003 grants `rds_iam`,
 * which requires `rds_superuser`, so the app role cannot bootstrap its own privileges. The
 * master credential is the RDS-managed secret in Secrets Manager; the function's IAM policy
 * grants it read on that one ARN and nothing else.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import pg from 'pg';
import type { ClientConfig } from 'pg';

import init0001 from '../../../migrations/0001_init.sql';
import orgBootstrap0002 from '../../../migrations/0002_org_bootstrap.sql';
import appRole0003 from '../../../migrations/0003_app_role.sql';
import { config, requireConfig } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';
import {
  buildMigrations,
  formatStatus,
  loadApplied,
  migrate,
  verifyIntegrity,
  withAdvisoryLock,
} from '../../shared/migrations/runner.js';
import type { MigrationSource } from '../../shared/migrations/runner.js';

/**
 * Every migration, in a list the compiler checks.
 *
 * `import` statements cannot be generated, so this is the one place in the codebase where a
 * file has to be registered by hand. `scripts/check-migrations.sh` compares this list
 * against the directory and fails the build on a mismatch, so the manual step cannot be
 * forgotten silently.
 */
const BUNDLED_MIGRATIONS: readonly MigrationSource[] = [
  { file: '0001_init.sql', sql: init0001 },
  { file: '0002_org_bootstrap.sql', sql: orgBootstrap0002 },
  { file: '0003_app_role.sql', sql: appRole0003 },
];

/**
 * Guards against a build that bundled an empty string.
 *
 * If the text loader were ever misconfigured, every import would resolve to `''`, the
 * migrations would "apply" with no effect, and the ledger would record success. The schema
 * would then be empty while everything reported fine — the worst possible failure here, and
 * cheap to rule out.
 */
function assertAllMigrationsBundled(): void {
  const empty = BUNDLED_MIGRATIONS.filter((m) => m.sql.trim().length === 0).map((m) => m.file);
  if (empty.length > 0) {
    throw new Error(
      `These migrations bundled as empty strings: ${empty.join(', ')}. The esbuild text ` +
        `loader for '.sql' is misconfigured — see backend/scripts/bundle.ts. Applying them ` +
        `would record success against a schema that was never created.`,
    );
  }
}

interface MasterCredential {
  username: string;
  password: string;
}

let cachedCredential: Promise<MasterCredential> | undefined;
let secretsClient: SecretsManagerClient | undefined;

async function fetchMasterCredential(): Promise<MasterCredential> {
  const secretArn = requireConfig('DB_MASTER_SECRET_ARN');

  secretsClient ??= new SecretsManagerClient({ region: config.AWS_REGION, maxAttempts: 3 });
  const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));

  if (response.SecretString === undefined) {
    throw new Error('The database master secret has no string value.');
  }

  // RDS-managed credentials are {"username":"...","password":"..."}. Parsed rather than
  // assumed so a hand-created secret in the wrong shape fails with a useful message.
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.SecretString);
  } catch {
    throw new Error(
      'The database master secret is not valid JSON. RDS-managed credentials are ' +
        '{"username":"...","password":"..."}.',
    );
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as MasterCredential).username !== 'string' ||
    typeof (parsed as MasterCredential).password !== 'string'
  ) {
    throw new Error(
      'The database master secret must contain string "username" and "password" fields.',
    );
  }

  return parsed as MasterCredential;
}

/** Memoises the in-flight promise, so two concurrent invocations share one fetch. */
function masterCredential(): Promise<MasterCredential> {
  cachedCredential ??= fetchMasterCredential().catch((err: unknown) => {
    cachedCredential = undefined;
    throw err;
  });
  return cachedCredential;
}

/**
 * A dedicated client rather than the shared pool from `src/shared/db.ts`.
 *
 * The pool connects as `worklens_app` with IAM auth; migrations need the master user with a
 * password. Beyond the credential, a migration can legitimately run for minutes, and the
 * pool sets a 20-second statement timeout that would cut an index build in half.
 */
async function connect(): Promise<pg.Client> {
  const credential = await masterCredential();

  const clientConfig: ClientConfig = {
    host: config.DB_HOST,
    port: config.DB_PORT,
    database: config.DB_NAME,
    user: credential.username,
    password: credential.password,
    ssl: sslConfig(),
    connectionTimeoutMillis: 15_000,
    // No statement timeout: see above. The Lambda's own timeout is the real ceiling.
    statement_timeout: 0,
    application_name: 'worklens-db-migrate',
  };

  const client = new pg.Client(clientConfig);
  await client.connect();
  return client;
}

function sslConfig(): ClientConfig['ssl'] {
  if (config.DB_SSL_MODE === 'disable') return false;
  if (config.DB_SSL_MODE === 'require') return { rejectUnauthorized: false };

  // The trust store ships in the deployment package — the private subnets have no route to
  // fetch it at runtime. bundle.ts copies it beside the handler.
  const here = dirname(fileURLToPath(import.meta.url));

  for (const candidate of [
    join(here, 'rds-ca-global-bundle.pem'),
    join(process.cwd(), 'rds-ca-global-bundle.pem'),
  ]) {
    try {
      return { ca: readFileSync(candidate, 'utf8'), rejectUnauthorized: true };
    } catch {
      // Try the next location.
    }
  }

  throw new Error(
    'DB_SSL_MODE is verify-full but rds-ca-global-bundle.pem is not in the deployment ' +
      'package. backend/scripts/bundle.ts copies it from backend/assets/; check that it ' +
      'is still there. Failing closed rather than connecting without verification.',
  );
}

export interface MigrateEvent {
  /** `apply` (the default) runs pending migrations; `status` and `dry-run` change nothing. */
  action?: 'apply' | 'status' | 'dry-run';
}

export interface MigrateResponse {
  ok: boolean;
  action: string;
  applied: string[];
  alreadyApplied: number;
  pending: string[];
  currentVersion: string | null;
  status: string;
  durationMs: number;
}

export async function handler(event: MigrateEvent = {}): Promise<MigrateResponse> {
  const started = Date.now();
  const action = event.action ?? 'apply';

  if (action !== 'apply' && action !== 'status' && action !== 'dry-run') {
    throw new Error(`Unknown action "${String(action)}". Expected apply, status, or dry-run.`);
  }

  assertAllMigrationsBundled();
  const migrations = buildMigrations(BUNDLED_MIGRATIONS);

  const log = logger.child({ handler: 'db-migrate', action });
  log.info('starting', { migrationCount: migrations.length });

  const client = await connect();

  try {
    if (action === 'status') {
      const applied = await withAdvisoryLock(client, async () => {
        const rows = await loadApplied(client);
        verifyIntegrity(migrations, rows);
        return rows;
      });

      const pending = migrations.filter((m) => !applied.has(m.version)).map((m) => m.version);
      const response: MigrateResponse = {
        ok: true,
        action,
        applied: [],
        alreadyApplied: applied.size,
        pending,
        currentVersion: [...applied.keys()].pop() ?? null,
        status: formatStatus(migrations, applied),
        durationMs: Date.now() - started,
      };
      log.info('status reported', { alreadyApplied: applied.size, pending: pending.length });
      return response;
    }

    const result = await migrate(client, migrations, {
      dryRun: action === 'dry-run',
      log: (message, fields) => {
        log.info(message, fields ?? {});
      },
    });

    const applied = await loadApplied(client);
    const response: MigrateResponse = {
      ok: true,
      action,
      applied: result.applied,
      alreadyApplied: result.alreadyApplied,
      pending: result.pending,
      currentVersion: result.currentVersion,
      status: formatStatus(migrations, applied),
      durationMs: Date.now() - started,
    };

    log.info('finished', {
      appliedCount: result.applied.length,
      currentVersion: result.currentVersion,
      durationMs: response.durationMs,
    });
    return response;
  } catch (err) {
    // Rethrown so the invocation is recorded as a failure — a migration that did not apply
    // must not look like a success in the console or to a deploy script checking the exit.
    log.error('migration run failed', { err, durationMs: Date.now() - started });
    throw err;
  } finally {
    // Always closed. Unlike a request handler, there is no benefit to keeping a migration
    // connection warm, and holding one wastes a slot on a db.t4g.micro.
    await client.end().catch(() => undefined);
  }
}
