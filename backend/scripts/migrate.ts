/**
 * Migration CLI.
 *
 * A thin shell around `src/shared/migrations/runner.ts`: this file owns reading `.sql` files
 * off disk and building a connection from the environment, and nothing else. The engine —
 * checksums, the advisory lock, gap detection, atomic application — is shared with the
 * in-VPC `db-migrate` Lambda, so the two cannot disagree about what "applied" means.
 *
 * This is the local and CI path. The deployed database sits in a private subnet with no
 * public access, so it is reached by invoking the Lambda instead:
 *
 *     aws lambda invoke --function-name worklens-prod-db-migrate --payload '{}' /dev/stdout
 *
 * Usage:
 *   npm run migrate                 apply everything pending
 *   npm run migrate -- --status     print the ledger and what is pending, change nothing
 *   npm run migrate -- --dry-run    report what would run, change nothing
 */

import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Signer } from '@aws-sdk/rds-signer';
import pg from 'pg';
import type { ClientConfig } from 'pg';

import {
  buildMigrations,
  formatStatus,
  loadApplied,
  migrate,
  verifyIntegrity,
  withAdvisoryLock,
} from '../src/shared/migrations/runner.js';
import type { Migration, MigrationSource } from '../src/shared/migrations/runner.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, '..', 'migrations');

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Loads backend/.env when present. Node's own loader, not a dependency; a missing file is
 * the normal case in CI, so it is not an error.
 */
function loadDotEnv(): void {
  const envPath = resolve(HERE, '..', '.env');
  if (!existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch {
    // Node < 20.12 has no loadEnvFile. The file exists, so the operator meant it to be
    // read; fall back to a minimal parser rather than ignoring it.
    for (const rawLine of readFileSync(envPath, 'utf8').split('\n')) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] ??= value;
    }
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. Copy backend/.env.example to backend/.env and fill it in, or ` +
        `export the variable. See docs/DEPLOYMENT.md.`,
    );
  }
  return value;
}

type SslMode = 'disable' | 'require' | 'verify-full';

function resolveSslMode(host: string): SslMode {
  const explicit = process.env.DB_SSL_MODE;
  if (explicit !== undefined && explicit !== '') {
    if (explicit !== 'disable' && explicit !== 'require' && explicit !== 'verify-full') {
      throw new Error(`DB_SSL_MODE must be disable, require, or verify-full (got "${explicit}")`);
    }
    return explicit;
  }
  // An RDS endpoint gets certificate verification by default; a local container has no
  // certificate to verify against. This makes both normal cases work unconfigured.
  return host.endsWith('.rds.amazonaws.com') ? 'verify-full' : 'disable';
}

function buildSslConfig(host: string): ClientConfig['ssl'] {
  const mode = resolveSslMode(host);
  if (mode === 'disable') return false;

  if (mode === 'require') {
    console.warn(
      '[migrate] DB_SSL_MODE=require: the connection is encrypted but the server ' +
        'certificate is NOT verified. Use verify-full with DB_SSL_CA_PATH in production.',
    );
    return { rejectUnauthorized: false };
  }

  // Defaults to the bundle committed for the Lambda packages, so verify-full works here
  // without the operator having to find it.
  const caPath = process.env.DB_SSL_CA_PATH ?? resolve(HERE, '..', 'assets', 'rds-ca-global-bundle.pem');
  if (!existsSync(caPath)) {
    throw new Error(
      `DB_SSL_MODE=verify-full but no CA bundle was found at ${caPath}. Set DB_SSL_CA_PATH, ` +
        `or restore backend/assets/rds-ca-global-bundle.pem with:\n` +
        `  curl -fsSL -o backend/assets/rds-ca-global-bundle.pem \\\n` +
        `    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`,
    );
  }
  return { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
}

/**
 * Password auth when DB_PASSWORD is set (local development); otherwise an RDS IAM token,
 * signed locally with no network call.
 */
async function buildClientConfig(): Promise<ClientConfig> {
  const host = required('DB_HOST');
  const port = Number(process.env.DB_PORT ?? '5432');
  const database = required('DB_NAME');
  const user = required('DB_MIGRATOR_USER');

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`DB_PORT must be a valid port number (got "${String(process.env.DB_PORT)}")`);
  }

  const base: ClientConfig = {
    host,
    port,
    database,
    user,
    ssl: buildSslConfig(host),
    // No statement timeout: an index build can legitimately take minutes, and cutting one
    // off half-way is worse than waiting. The connection timeout stays short so an
    // unreachable database fails a deploy fast rather than hanging it.
    connectionTimeoutMillis: 15_000,
    statement_timeout: 0,
    application_name: 'worklens-migrate',
  };

  const password = process.env.DB_PASSWORD;
  if (password !== undefined && password !== '') return { ...base, password };

  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (region === undefined || region === '') {
    throw new Error(
      'Neither DB_PASSWORD nor AWS_REGION is set. Set DB_PASSWORD for password ' +
        'authentication against a local database, or AWS_REGION to use RDS IAM ' +
        'authentication. Note that the deployed database is not reachable from a laptop at ' +
        'all — invoke the db-migrate Lambda instead.',
    );
  }

  console.log(`[migrate] signing an RDS IAM auth token for ${user}@${host}:${port}`);
  const signer = new Signer({ hostname: host, port, username: user, region });
  return { ...base, password: await signer.getAuthToken() };
}

// ---------------------------------------------------------------------------
// Migration discovery
// ---------------------------------------------------------------------------

async function loadMigrationsFromDisk(): Promise<Migration[]> {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  const sources: MigrationSource[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.sql')) continue;
    sources.push({
      file: entry.name,
      sql: await readFile(join(MIGRATIONS_DIR, entry.name), 'utf8'),
    });
  }

  return buildMigrations(sources);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  for (const arg of args) {
    if (arg !== '--status' && arg !== '--dry-run') {
      throw new Error(`Unknown argument "${arg}". Supported: --status, --dry-run`);
    }
  }
  const statusOnly = args.has('--status');
  const dryRun = args.has('--dry-run');

  loadDotEnv();

  const migrations = await loadMigrationsFromDisk();
  if (migrations.length === 0) {
    console.log('[migrate] no migration files found — nothing to do');
    return;
  }

  const client = new pg.Client(await buildClientConfig());
  await client.connect();

  try {
    if (statusOnly) {
      // Under the lock as well: reading the ledger while another runner is mid-apply would
      // print a half-applied picture.
      const applied = await withAdvisoryLock(client, async () => {
        const rows = await loadApplied(client);
        verifyIntegrity(migrations, rows);
        return rows;
      });
      console.log('');
      console.log(formatStatus(migrations, applied));
      console.log('');
      return;
    }

    const result = await migrate(client, migrations, {
      dryRun,
      log: (message, fields) => {
        const duration = fields?.durationMs;
        const detail = typeof duration === 'number' ? ` (${duration} ms)` : '';
        console.log(`[migrate] ${message}${detail}`);
      },
    });

    if (dryRun) {
      if (result.pending.length === 0) {
        console.log(`[migrate] --dry-run: up to date, ${result.alreadyApplied} already applied`);
      } else {
        console.log(`[migrate] --dry-run: ${result.pending.length} migration(s) would be applied:`);
        for (const version of result.pending) console.log(`  ${version}`);
      }
      return;
    }

    if (result.applied.length === 0) {
      console.log(`[migrate] up to date — ${result.alreadyApplied} migration(s) already applied`);
      return;
    }

    console.log(
      `[migrate] done — applied ${result.applied.length}, database is at ` +
        `${result.currentVersion ?? 'unknown'}`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n[migrate] ${message}\n`);
  process.exitCode = 1;
});
