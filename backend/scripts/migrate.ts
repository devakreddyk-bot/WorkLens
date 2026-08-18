/**
 * Forward-only migration runner.
 *
 * Applies every unapplied file in `backend/migrations/` in filename order, wrapping each
 * migration and its ledger row in a single transaction so a migration is either applied
 * and recorded or neither.
 *
 * Safety properties, in order of how much grief each one saves:
 *
 *  1. **Checksum enforcement.** The sha256 of every applied file is stored. If an applied
 *     file changes on disk, the runner aborts instead of silently leaving two databases
 *     at "version 0002" with different schemas.
 *  2. **Advisory lock.** Two concurrent runs (a CI job and a human, say) cannot interleave.
 *  3. **Atomicity.** See above. Files carry no BEGIN/COMMIT; see migrations/README.md.
 *  4. **Gap detection.** A file numbered below the highest applied version that has not
 *     itself been applied is an error — it means a migration was merged out of order and
 *     applying it now would run it against a schema it was never written for.
 *
 * Usage:
 *   npm run migrate                 apply everything pending
 *   npm run migrate -- --status     print the ledger and what is pending, change nothing
 *   npm run migrate -- --dry-run    report what would run, change nothing
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { Signer } from '@aws-sdk/rds-signer';
import pg from 'pg';
import type { ClientConfig } from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, '..', 'migrations');

/** Arbitrary but fixed: two runners must pick the same key to exclude each other. */
const ADVISORY_LOCK_KEY = 0x776c_6d67; // "wlmg"

const MIGRATION_FILE_RE = /^(\d{4})_[a-z0-9_]+(\.no-transaction)?\.sql$/;

interface Migration {
  /** Filename without the .sql suffix — this is what lands in schema_migrations.version. */
  version: string;
  file: string;
  sequence: number;
  checksum: string;
  sql: string;
  /** True for `*.no-transaction.sql`; runs outside a transaction. */
  noTransaction: boolean;
}

interface AppliedRow {
  version: string;
  checksum: string;
  applied_at: Date;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Loads backend/.env when present. Node's own loader is used rather than a dependency;
 * a missing file is the normal case in CI and in Lambda, so it is not an error.
 */
function loadDotEnv(): void {
  const envPath = resolve(HERE, '..', '.env');
  if (!existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch (err) {
    // Node < 20.12 has no loadEnvFile. Fall back to a minimal parser rather than
    // failing: the file exists, so the operator clearly intended it to be read.
    const text = readFileSync(envPath, 'utf8');
    for (const rawLine of text.split('\n')) {
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
    void err;
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. Copy backend/.env.example to backend/.env and fill it in, ` +
        `or export the variable. See docs/DEPLOYMENT.md.`,
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
  // An RDS endpoint always gets certificate verification by default. A local database
  // does not, because a dev container has no certificate to verify against.
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

  const caPath = process.env.DB_SSL_CA_PATH;
  if (caPath === undefined || caPath === '') {
    throw new Error(
      'DB_SSL_MODE=verify-full requires DB_SSL_CA_PATH pointing at the RDS CA bundle. ' +
        'Download it with: curl -o rds-ca.pem ' +
        'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem',
    );
  }
  if (!existsSync(caPath)) {
    throw new Error(`DB_SSL_CA_PATH points at a file that does not exist: ${caPath}`);
  }
  return { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
}

/**
 * Builds the connection config. Password auth is used when DB_PASSWORD is set (local
 * development); otherwise an RDS IAM authentication token is signed locally, which is
 * how the deployed stack connects — no database password exists anywhere in it.
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
    // Migrations can legitimately take a while (index builds); a short statement timeout
    // here would be actively harmful. The connection timeout stays short because an
    // unreachable database should fail fast rather than hang a deploy.
    connectionTimeoutMillis: 15_000,
    statement_timeout: 0,
    application_name: 'worklens-migrate',
  };

  const password = process.env.DB_PASSWORD;
  if (password !== undefined && password !== '') {
    return { ...base, password };
  }

  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (region === undefined || region === '') {
    throw new Error(
      'Neither DB_PASSWORD nor AWS_REGION is set. Set DB_PASSWORD for password ' +
        'authentication against a local database, or AWS_REGION to use RDS IAM ' +
        'authentication against the deployed instance.',
    );
  }

  console.log(`[migrate] signing an RDS IAM auth token for ${user}@${host}:${port}`);
  const signer = new Signer({ hostname: host, port, username: user, region });
  return { ...base, password: await signer.getAuthToken() };
}

// ---------------------------------------------------------------------------
// Migration discovery
// ---------------------------------------------------------------------------

async function loadMigrations(): Promise<Migration[]> {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  const migrations: Migration[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.sql')) continue;

    const match = MIGRATION_FILE_RE.exec(entry.name);
    if (match === null) {
      throw new Error(
        `Migration filename "${entry.name}" does not match NNNN_snake_case_name.sql ` +
          `(optionally NNNN_name.no-transaction.sql). Rename it — the runner orders ` +
          `migrations by that prefix and will not guess.`,
      );
    }

    const sql = await readFile(join(MIGRATIONS_DIR, entry.name), 'utf8');
    migrations.push({
      version: entry.name.replace(/\.sql$/, ''),
      file: entry.name,
      sequence: Number(match[1]),
      checksum: createHash('sha256').update(sql, 'utf8').digest('hex'),
      sql,
      noTransaction: match[2] !== undefined,
    });
  }

  migrations.sort((a, b) => a.sequence - b.sequence || a.version.localeCompare(b.version));

  const seen = new Map<number, string>();
  for (const m of migrations) {
    const existing = seen.get(m.sequence);
    if (existing !== undefined) {
      throw new Error(
        `Two migrations share the sequence number ${m.sequence}: "${existing}" and ` +
          `"${m.file}". Renumber one of them.`,
      );
    }
    seen.set(m.sequence, m.file);
  }

  return migrations;
}

async function loadApplied(client: pg.Client): Promise<Map<string, AppliedRow>> {
  // The ledger table is created by 0001, so on a virgin database it does not exist yet.
  const exists = await client.query<{ exists: boolean }>(
    `select exists (
       select 1 from information_schema.tables
       where table_schema = 'public' and table_name = 'schema_migrations'
     ) as exists`,
  );

  if (exists.rows[0]?.exists !== true) return new Map();

  const result = await client.query<AppliedRow>(
    'select version, checksum, applied_at from schema_migrations order by version',
  );
  return new Map(result.rows.map((row) => [row.version, row]));
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

function verifyIntegrity(migrations: Migration[], applied: Map<string, AppliedRow>): void {
  const problems: string[] = [];

  for (const m of migrations) {
    const row = applied.get(m.version);
    if (row !== undefined && row.checksum !== m.checksum) {
      problems.push(
        `  ${m.file} was applied on ${row.applied_at.toISOString()} but its contents have ` +
          `changed since (recorded ${row.checksum.slice(0, 12)}…, now ` +
          `${m.checksum.slice(0, 12)}…).`,
      );
    }
  }

  for (const version of applied.keys()) {
    if (!migrations.some((m) => m.version === version)) {
      problems.push(
        `  ${version} is recorded as applied but no such file exists in migrations/. ` +
          `Deleting an applied migration breaks reproducibility from scratch.`,
      );
    }
  }

  // Out-of-order merges: a pending file numbered below something already applied.
  const highestApplied = Math.max(
    0,
    ...migrations.filter((m) => applied.has(m.version)).map((m) => m.sequence),
  );
  for (const m of migrations) {
    if (!applied.has(m.version) && m.sequence < highestApplied) {
      problems.push(
        `  ${m.file} (sequence ${m.sequence}) is pending, but migration ${highestApplied} ` +
          `has already been applied. It was written against an earlier schema; renumber ` +
          `it above ${highestApplied} after checking it is still correct.`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Migration state is inconsistent. Forward-only means applied files are immutable.\n` +
        problems.join('\n'),
    );
  }
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

async function applyMigration(client: pg.Client, m: Migration): Promise<void> {
  const label = `${m.file}${m.noTransaction ? ' (outside a transaction)' : ''}`;
  const started = Date.now();
  process.stdout.write(`[migrate] applying ${label} … `);

  const ledger = {
    text: `insert into schema_migrations (version, checksum) values ($1, $2)`,
    values: [m.version, m.checksum],
  };

  if (m.noTransaction) {
    await client.query(m.sql);
    await client.query(ledger);
  } else {
    await client.query('begin');
    try {
      await client.query(m.sql);
      await client.query(ledger);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {
        /* the original error is what matters; a failed rollback must not mask it */
      });
      process.stdout.write('failed\n');
      throw err;
    }
  }

  process.stdout.write(`ok (${Date.now() - started} ms)\n`);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printStatus(migrations: Migration[], applied: Map<string, AppliedRow>): void {
  console.log('');
  console.log('  status    version                       applied at');
  console.log('  --------  ----------------------------  ------------------------');
  for (const m of migrations) {
    const row = applied.get(m.version);
    const status = row === undefined ? 'PENDING ' : 'applied ';
    const when = row === undefined ? '-' : row.applied_at.toISOString();
    console.log(`  ${status}  ${m.version.padEnd(28)}  ${when}`);
  }
  const pending = migrations.filter((m) => !applied.has(m.version)).length;
  console.log('');
  console.log(
    `  ${migrations.length} migration(s) on disk, ${applied.size} applied, ${pending} pending.`,
  );
  console.log('');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const statusOnly = args.has('--status');
  const dryRun = args.has('--dry-run');

  for (const arg of args) {
    if (arg !== '--status' && arg !== '--dry-run') {
      throw new Error(`Unknown argument "${arg}". Supported: --status, --dry-run`);
    }
  }

  loadDotEnv();

  const migrations = await loadMigrations();
  if (migrations.length === 0) {
    console.log('[migrate] no migration files found — nothing to do');
    return;
  }

  const client = new pg.Client(await buildClientConfig());
  await client.connect();

  try {
    // Serialise concurrent runners. Released implicitly when the session ends, but
    // released explicitly below so a long-lived pooled connection would also be safe.
    await client.query('select pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);

    try {
      const applied = await loadApplied(client);
      verifyIntegrity(migrations, applied);

      if (statusOnly) {
        printStatus(migrations, applied);
        return;
      }

      const pending = migrations.filter((m) => !applied.has(m.version));

      if (pending.length === 0) {
        console.log(`[migrate] up to date — ${applied.size} migration(s) already applied`);
        return;
      }

      if (dryRun) {
        console.log(`[migrate] --dry-run: ${pending.length} migration(s) would be applied:`);
        for (const m of pending) console.log(`  ${m.file}`);
        return;
      }

      console.log(`[migrate] ${pending.length} migration(s) to apply`);
      for (const m of pending) {
        await applyMigration(client, m);
      }
      const last = pending[pending.length - 1];
      console.log(`[migrate] done — database is at ${last?.version ?? 'unknown'}`);
    } finally {
      await client.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {
        /* the session is about to close, which releases the lock regardless */
      });
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n[migrate] ${message}\n`);
  process.exitCode = 1;
});
