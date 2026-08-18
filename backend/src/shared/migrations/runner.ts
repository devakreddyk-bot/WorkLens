/**
 * The migration engine, shared by two callers with very different shapes.
 *
 * `backend/scripts/migrate.ts` reads the `.sql` files off disk and runs against whatever
 * database the environment points at — that is the local development path.
 *
 * `backend/src/handlers/jobs/dbMigrate.ts` runs inside the VPC with the same `.sql` files
 * embedded in its bundle, because RDS lives in a private subnet with no public access and
 * a laptop simply cannot reach it. That Lambda is the only route migrations have into the
 * deployed database.
 *
 * Two callers, one implementation, on purpose. A second copy of "which migrations have
 * been applied and is it safe to apply the next one" would drift, and the failure mode of
 * that drift is a schema that differs between environments while both report success.
 *
 * Everything here is expressed against a minimal `MigrationClient` interface rather than a
 * `pg.Client`, so it is testable with a fake and works with a bare client or a pooled one.
 *
 * The safety properties, in order of how much grief each one saves:
 *
 *  1. **Checksum enforcement.** The sha256 of every applied file is recorded. If an applied
 *     file changes, the run aborts — otherwise two databases sit at "version 0002" with
 *     different schemas and nothing says so.
 *  2. **Advisory lock.** Two concurrent runners (CI and a human, or two Lambda invocations)
 *     cannot interleave.
 *  3. **Atomicity.** Each migration and its ledger row commit together, so a migration is
 *     either applied and recorded or neither.
 *  4. **Gap detection.** A pending file numbered below something already applied is an
 *     error: it was written against an earlier schema and was merged out of order.
 */

import { createHash } from 'node:crypto';

/** Arbitrary but fixed — two runners must choose the same key to exclude each other. */
export const ADVISORY_LOCK_KEY = 0x776c_6d67; // "wlmg"

export const MIGRATION_FILE_RE = /^(\d{4})_[a-z0-9_]+(\.no-transaction)?\.sql$/;

/** A migration as supplied by a caller: a filename and its contents. */
export interface MigrationSource {
  file: string;
  sql: string;
}

export interface Migration {
  /** Filename without `.sql`. This is what lands in `schema_migrations.version`. */
  version: string;
  file: string;
  sequence: number;
  checksum: string;
  sql: string;
  /**
   * True for `*.no-transaction.sql`. `CREATE INDEX CONCURRENTLY` and
   * `ALTER TYPE ... ADD VALUE` cannot run inside a transaction; naming the file is how that
   * trade-off is made explicit rather than hidden inside the SQL.
   */
  noTransaction: boolean;
}

export interface AppliedMigration {
  version: string;
  checksum: string;
  applied_at: Date;
}

/**
 * The slice of a Postgres client this module needs. `pg.Client` and `pg.PoolClient` both
 * satisfy it structurally, and a test double is three lines.
 */
export interface MigrationClient {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

/** Where progress messages go. The CLI prints; the Lambda logs structured JSON. */
export type MigrationLogger = (message: string, fields?: Record<string, unknown>) => void;

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/**
 * Validates, orders and de-duplicates a set of sources.
 *
 * Ordering is by the numeric prefix, not by string comparison, and a duplicate sequence
 * number is an error rather than something resolved by a tiebreak — two migrations claiming
 * to be number 4 means a merge went wrong, and picking one silently would apply them in an
 * order nobody chose.
 */
export function buildMigrations(sources: readonly MigrationSource[]): Migration[] {
  const migrations: Migration[] = [];

  for (const source of sources) {
    const match = MIGRATION_FILE_RE.exec(source.file);
    if (match === null) {
      throw new Error(
        `Migration filename "${source.file}" does not match NNNN_snake_case_name.sql ` +
          `(optionally NNNN_name.no-transaction.sql). Rename it — migrations are ordered by ` +
          `that prefix and the runner will not guess.`,
      );
    }

    migrations.push({
      version: source.file.replace(/\.sql$/, ''),
      file: source.file,
      sequence: Number(match[1]),
      checksum: checksumOf(source.sql),
      sql: source.sql,
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

export async function loadApplied(
  client: MigrationClient,
): Promise<Map<string, AppliedMigration>> {
  // On a virgin database the ledger does not exist yet — 0001 creates it.
  const exists = await client.query<{ exists: boolean }>(
    `select exists (
       select 1 from information_schema.tables
       where table_schema = 'public' and table_name = 'schema_migrations'
     ) as exists`,
  );

  if (exists.rows[0]?.exists !== true) return new Map();

  const result = await client.query<AppliedMigration>(
    'select version, checksum, applied_at from schema_migrations order by version',
  );
  return new Map(result.rows.map((row) => [row.version, row]));
}

/**
 * Throws when the on-disk set and the ledger disagree in any way that makes applying the
 * remainder unsafe. Every problem is collected before throwing, so one run reports all of
 * them rather than making the operator fix them one at a time.
 */
export function verifyIntegrity(
  migrations: readonly Migration[],
  applied: ReadonlyMap<string, AppliedMigration>,
): void {
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
        `  ${version} is recorded as applied but no such file is present. Deleting an ` +
          `applied migration breaks the ability to reproduce the schema from scratch.`,
      );
    }
  }

  const highestApplied = Math.max(
    0,
    ...migrations.filter((m) => applied.has(m.version)).map((m) => m.sequence),
  );
  for (const m of migrations) {
    if (!applied.has(m.version) && m.sequence < highestApplied) {
      problems.push(
        `  ${m.file} (sequence ${m.sequence}) is pending, but migration ${highestApplied} ` +
          `has already been applied. It was written against an earlier schema; renumber it ` +
          `above ${highestApplied} after checking it is still correct.`,
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

export function pendingMigrations(
  migrations: readonly Migration[],
  applied: ReadonlyMap<string, AppliedMigration>,
): Migration[] {
  return migrations.filter((m) => !applied.has(m.version));
}

const LEDGER_INSERT = 'insert into schema_migrations (version, checksum) values ($1, $2)';

/**
 * Applies one migration.
 *
 * The transaction wraps the SQL *and* the ledger insert, which is why the migration files
 * themselves carry no BEGIN/COMMIT — see backend/migrations/README.md. A file with its own
 * transaction would put the ledger row outside it, and a crash in between would leave the
 * schema changed but unrecorded.
 */
export async function applyMigration(
  client: MigrationClient,
  migration: Migration,
  log: MigrationLogger,
): Promise<number> {
  const started = Date.now();

  if (migration.noTransaction) {
    await client.query(migration.sql);
    await client.query(LEDGER_INSERT, [migration.version, migration.checksum]);
  } else {
    await client.query('begin');
    try {
      await client.query(migration.sql);
      await client.query(LEDGER_INSERT, [migration.version, migration.checksum]);
      await client.query('commit');
    } catch (err) {
      try {
        await client.query('rollback');
      } catch {
        // The original error is what matters; a failed rollback must not mask it.
      }
      throw err;
    }
  }

  const durationMs = Date.now() - started;
  log(`applied ${migration.file}`, {
    version: migration.version,
    durationMs,
    outsideTransaction: migration.noTransaction,
  });
  return durationMs;
}

/**
 * Runs `fn` while holding the advisory lock.
 *
 * The lock is session-scoped, so it releases when the connection closes even if the
 * explicit unlock never runs. Unlocking anyway matters for the Lambda, whose pooled
 * connection outlives the invocation.
 */
export async function withAdvisoryLock<T>(
  client: MigrationClient,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('select pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
  try {
    return await fn();
  } finally {
    try {
      await client.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    } catch {
      // Session end releases it regardless.
    }
  }
}

export interface MigrateResult {
  /** Versions applied by this run, in order. */
  applied: string[];
  /** How many were already recorded before this run. */
  alreadyApplied: number;
  /** Versions that would have been applied. Populated only for a dry run. */
  pending: string[];
  dryRun: boolean;
  /** The highest version now recorded, or null on an empty database. */
  currentVersion: string | null;
}

export interface MigrateOptions {
  dryRun?: boolean;
  log?: MigrationLogger;
}

/**
 * The whole operation: take the lock, verify integrity, apply what is pending.
 *
 * Verification happens inside the lock. Outside it, two runners could both read a
 * consistent ledger, both decide the same migration is pending, and both try to apply it.
 */
export async function migrate(
  client: MigrationClient,
  migrations: readonly Migration[],
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  const log = options.log ?? (() => undefined);
  const dryRun = options.dryRun ?? false;

  return withAdvisoryLock(client, async () => {
    const applied = await loadApplied(client);
    verifyIntegrity(migrations, applied);

    const pending = pendingMigrations(migrations, applied);

    if (dryRun || pending.length === 0) {
      return {
        applied: [],
        alreadyApplied: applied.size,
        pending: pending.map((m) => m.version),
        dryRun,
        currentVersion: highestVersion(migrations, applied),
      };
    }

    const done: string[] = [];
    for (const migration of pending) {
      await applyMigration(client, migration, log);
      done.push(migration.version);
    }

    return {
      applied: done,
      alreadyApplied: applied.size,
      pending: [],
      dryRun: false,
      currentVersion: done[done.length - 1] ?? highestVersion(migrations, applied),
    };
  });
}

function highestVersion(
  migrations: readonly Migration[],
  applied: ReadonlyMap<string, AppliedMigration>,
): string | null {
  const appliedInOrder = migrations.filter((m) => applied.has(m.version));
  return appliedInOrder[appliedInOrder.length - 1]?.version ?? null;
}

/** Human-readable ledger table, for the CLI's `--status` and the Lambda's response. */
export function formatStatus(
  migrations: readonly Migration[],
  applied: ReadonlyMap<string, AppliedMigration>,
): string {
  const lines = [
    '  status    version                       applied at',
    '  --------  ----------------------------  ------------------------',
  ];

  for (const m of migrations) {
    const row = applied.get(m.version);
    lines.push(
      `  ${row === undefined ? 'PENDING ' : 'applied '}  ${m.version.padEnd(28)}  ` +
        `${row === undefined ? '-' : row.applied_at.toISOString()}`,
    );
  }

  const pending = migrations.length - applied.size;
  lines.push(
    '',
    `  ${migrations.length} migration(s) known, ${applied.size} applied, ${pending} pending.`,
  );
  return lines.join('\n');
}
