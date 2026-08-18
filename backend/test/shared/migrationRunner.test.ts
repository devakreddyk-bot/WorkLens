/**
 * Tests for the migration engine.
 *
 * The engine is shared by the CLI and the in-VPC `db-migrate` Lambda, so a bug here is a bug
 * in both. The cases below are the ones where getting it wrong produces a *silent* wrong
 * answer — a schema that differs between environments while both report success — rather
 * than a visible error.
 *
 * A fake client is used rather than a database. Every statement is recorded, so the tests can
 * assert on ordering: that the ledger insert lands inside the same transaction as the
 * migration, that a failure rolls back, and that the advisory lock brackets the whole run.
 */

import { describe, expect, it } from 'vitest';

import {
  ADVISORY_LOCK_KEY,
  buildMigrations,
  checksumOf,
  formatStatus,
  loadApplied,
  migrate,
  pendingMigrations,
  verifyIntegrity,
  withAdvisoryLock,
} from '../../src/shared/migrations/runner.js';
import type { AppliedMigration, MigrationClient } from '../../src/shared/migrations/runner.js';

// ---------------------------------------------------------------------------
// Fake client
// ---------------------------------------------------------------------------

interface FakeOptions {
  /** Versions already in the ledger. */
  applied?: { version: string; checksum: string; appliedAt?: Date }[];
  /** True when schema_migrations does not exist yet (a virgin database). */
  noLedger?: boolean;
  /** SQL substring that should throw when executed, to simulate a failing migration. */
  failOn?: string;
}

function fakeClient(options: FakeOptions = {}): MigrationClient & { statements: string[] } {
  const statements: string[] = [];
  const applied = options.applied ?? [];

  return {
    statements,
    // eslint-disable-next-line @typescript-eslint/require-await
    async query<T>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }> {
      statements.push(text.trim());

      if (options.failOn !== undefined && text.includes(options.failOn)) {
        throw new Error(`simulated failure executing: ${options.failOn}`);
      }

      if (text.includes('information_schema.tables')) {
        return { rows: [{ exists: options.noLedger !== true }] as T[], rowCount: 1 };
      }

      if (text.includes('from schema_migrations')) {
        return {
          rows: applied.map((row) => ({
            version: row.version,
            checksum: row.checksum,
            applied_at: row.appliedAt ?? new Date('2026-08-01T00:00:00.000Z'),
          })) as T[],
          rowCount: applied.length,
        };
      }

      void values;
      return { rows: [], rowCount: 0 };
    },
  };
}

const SOURCES = [
  { file: '0001_init.sql', sql: 'create table a ();' },
  { file: '0002_more.sql', sql: 'create table b ();' },
];

// ---------------------------------------------------------------------------

describe('buildMigrations', () => {
  it('derives version, sequence and checksum from the filename and contents', () => {
    const [first] = buildMigrations(SOURCES);
    expect(first).toMatchObject({
      version: '0001_init',
      file: '0001_init.sql',
      sequence: 1,
      noTransaction: false,
    });
    expect(first?.checksum).toBe(checksumOf('create table a ();'));
  });

  it('orders numerically, not lexicographically', () => {
    // '0010' sorts before '0009' as a string. Getting this wrong applies migrations in the
    // wrong order, which is the kind of bug that only shows up at migration ten.
    const built = buildMigrations([
      { file: '0010_ten.sql', sql: 'select 10;' },
      { file: '0009_nine.sql', sql: 'select 9;' },
      { file: '0002_two.sql', sql: 'select 2;' },
    ]);
    expect(built.map((m) => m.sequence)).toEqual([2, 9, 10]);
  });

  it('recognises the .no-transaction suffix', () => {
    const [m] = buildMigrations([
      { file: '0004_add_index.no-transaction.sql', sql: 'create index concurrently i on a (b);' },
    ]);
    expect(m?.noTransaction).toBe(true);
    expect(m?.version).toBe('0004_add_index.no-transaction');
  });

  it.each([
    ['no numeric prefix', 'init.sql'],
    ['too few digits', '001_init.sql'],
    ['upper case', '0001_Init.sql'],
    ['hyphens instead of underscores', '0001-init.sql'],
    ['wrong extension', '0001_init.psql'],
  ])('rejects a filename with %s', (_label, file) => {
    expect(() => buildMigrations([{ file, sql: 'select 1;' }])).toThrow(/does not match/);
  });

  it('rejects two migrations sharing a sequence number', () => {
    // A merge produced two number 4s. Picking one silently would apply them in an order
    // nobody chose.
    expect(() =>
      buildMigrations([
        { file: '0004_alpha.sql', sql: 'select 1;' },
        { file: '0004_beta.sql', sql: 'select 2;' },
      ]),
    ).toThrow(/share the sequence number 4/);
  });

  it('accepts an empty set', () => {
    expect(buildMigrations([])).toEqual([]);
  });
});

describe('checksumOf', () => {
  it('changes when a single character changes', () => {
    expect(checksumOf('select 1;')).not.toBe(checksumOf('select 1; '));
  });

  it('is a sha256 hex digest', () => {
    expect(checksumOf('select 1;')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('loadApplied', () => {
  it('returns an empty map on a database with no ledger table', async () => {
    const client = fakeClient({ noLedger: true });
    await expect(loadApplied(client)).resolves.toEqual(new Map());
    // It must not go on to query a table it just learned does not exist.
    expect(client.statements.some((s) => s.includes('from schema_migrations'))).toBe(false);
  });

  it('reads the ledger when it exists', async () => {
    const client = fakeClient({ applied: [{ version: '0001_init', checksum: 'abc' }] });
    const applied = await loadApplied(client);
    expect(applied.get('0001_init')?.checksum).toBe('abc');
  });
});

describe('verifyIntegrity', () => {
  const migrations = buildMigrations(SOURCES);

  function ledger(entries: [string, string][]): Map<string, AppliedMigration> {
    return new Map(
      entries.map(([version, checksum]) => [
        version,
        { version, checksum, applied_at: new Date('2026-08-01T00:00:00.000Z') },
      ]),
    );
  }

  it('passes when nothing is applied', () => {
    expect(() => verifyIntegrity(migrations, new Map())).not.toThrow();
  });

  it('passes when the applied checksums match', () => {
    expect(() =>
      verifyIntegrity(migrations, ledger([['0001_init', checksumOf('create table a ();')]])),
    ).not.toThrow();
  });

  it('rejects an applied file whose contents changed', () => {
    // The whole point of the checksum: without this, two databases sit at the same version
    // with different schemas and nothing says so.
    expect(() => verifyIntegrity(migrations, ledger([['0001_init', 'a'.repeat(64)]]))).toThrow(
      /contents have changed since/,
    );
  });

  it('rejects a ledger entry with no corresponding file', () => {
    expect(() =>
      verifyIntegrity(migrations, ledger([['0099_deleted', 'a'.repeat(64)]])),
    ).toThrow(/no such file is present/);
  });

  it('rejects a pending migration numbered below one already applied', () => {
    // An out-of-order merge. 0002 is applied, 0001 is not — applying 0001 now would run it
    // against a schema it was never written for.
    const built = buildMigrations(SOURCES);
    expect(() =>
      verifyIntegrity(built, ledger([['0002_more', checksumOf('create table b ();')]])),
    ).toThrow(/is pending, but migration 2 has already been applied/);
  });

  it('reports every problem at once rather than one per run', () => {
    let message = '';
    try {
      verifyIntegrity(migrations, ledger([['0001_init', 'a'.repeat(64)], ['0099_gone', 'b'.repeat(64)]]));
    } catch (err) {
      message = err instanceof Error ? err.message : '';
    }
    expect(message).toContain('contents have changed');
    expect(message).toContain('no such file is present');
  });
});

describe('pendingMigrations', () => {
  it('excludes what is already applied, preserving order', () => {
    const migrations = buildMigrations(SOURCES);
    const applied = new Map<string, AppliedMigration>([
      ['0001_init', { version: '0001_init', checksum: checksumOf('create table a ();'), applied_at: new Date() }],
    ]);
    expect(pendingMigrations(migrations, applied).map((m) => m.version)).toEqual(['0002_more']);
  });
});

describe('withAdvisoryLock', () => {
  it('takes and releases the lock around the callback', async () => {
    const client = fakeClient();
    await withAdvisoryLock(client, () => Promise.resolve('done'));
    expect(client.statements[0]).toContain('pg_advisory_lock');
    expect(client.statements.at(-1)).toContain('pg_advisory_unlock');
  });

  it('releases the lock even when the callback throws', async () => {
    // Otherwise one failed run leaves the lock held and every later run blocks forever.
    const client = fakeClient();
    await expect(
      withAdvisoryLock(client, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(client.statements.at(-1)).toContain('pg_advisory_unlock');
  });

  it('uses a fixed key, so two runners actually exclude each other', () => {
    expect(ADVISORY_LOCK_KEY).toBe(0x776c_6d67);
  });
});

describe('migrate', () => {
  it('applies everything pending, in order', async () => {
    const client = fakeClient();
    const result = await migrate(client, buildMigrations(SOURCES));

    expect(result.applied).toEqual(['0001_init', '0002_more']);
    expect(result.currentVersion).toBe('0002_more');
    expect(client.statements.filter((s) => s === 'create table a ();')).toHaveLength(1);
  });

  it('commits the ledger row inside the migration transaction', async () => {
    // If the insert landed outside, a crash between commit and insert would leave the schema
    // changed but unrecorded — and the next run would try to apply it again.
    const client = fakeClient();
    await migrate(client, buildMigrations([SOURCES[0]!]));

    const s = client.statements;
    const begin = s.indexOf('begin');
    const ddl = s.indexOf('create table a ();');
    const ledger = s.findIndex((x) => x.includes('insert into schema_migrations'));
    const commit = s.indexOf('commit');

    expect(begin).toBeGreaterThanOrEqual(0);
    expect(begin).toBeLessThan(ddl);
    expect(ddl).toBeLessThan(ledger);
    expect(ledger).toBeLessThan(commit);
  });

  it('rolls back and rethrows when a migration fails', async () => {
    const client = fakeClient({ failOn: 'create table b ()' });
    await expect(migrate(client, buildMigrations(SOURCES))).rejects.toThrow(/simulated failure/);

    expect(client.statements).toContain('rollback');
    // The first migration still committed; forward-only means partial progress is recorded.
    expect(client.statements.filter((x) => x === 'commit')).toHaveLength(1);
  });

  it('does nothing when everything is applied', async () => {
    const client = fakeClient({
      applied: [
        { version: '0001_init', checksum: checksumOf('create table a ();') },
        { version: '0002_more', checksum: checksumOf('create table b ();') },
      ],
    });
    const result = await migrate(client, buildMigrations(SOURCES));

    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toBe(2);
    expect(client.statements).not.toContain('begin');
  });

  it('changes nothing on a dry run but reports what would happen', async () => {
    const client = fakeClient();
    const result = await migrate(client, buildMigrations(SOURCES), { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.pending).toEqual(['0001_init', '0002_more']);
    expect(result.applied).toEqual([]);
    expect(client.statements).not.toContain('begin');
    expect(client.statements.some((s) => s.includes('insert into schema_migrations'))).toBe(false);
  });

  it('verifies integrity inside the lock, before applying anything', async () => {
    const client = fakeClient({ applied: [{ version: '0001_init', checksum: 'a'.repeat(64) }] });
    await expect(migrate(client, buildMigrations(SOURCES))).rejects.toThrow(/contents have changed/);

    // Nothing applied, and the lock was still released.
    expect(client.statements).not.toContain('begin');
    expect(client.statements.at(-1)).toContain('pg_advisory_unlock');
  });

  it('runs a no-transaction migration without begin/commit', async () => {
    const client = fakeClient();
    await migrate(
      client,
      buildMigrations([{ file: '0001_idx.no-transaction.sql', sql: 'create index concurrently i on a (b);' }]),
    );

    expect(client.statements).not.toContain('begin');
    expect(client.statements).toContain('create index concurrently i on a (b);');
    expect(client.statements.some((s) => s.includes('insert into schema_migrations'))).toBe(true);
  });

  it('passes progress to the supplied logger', async () => {
    const seen: string[] = [];
    await migrate(fakeClient(), buildMigrations(SOURCES), {
      log: (message) => seen.push(message),
    });
    expect(seen).toEqual(['applied 0001_init.sql', 'applied 0002_more.sql']);
  });
});

describe('formatStatus', () => {
  it('marks applied and pending rows and counts both', () => {
    const migrations = buildMigrations(SOURCES);
    const applied = new Map<string, AppliedMigration>([
      [
        '0001_init',
        {
          version: '0001_init',
          checksum: checksumOf('create table a ();'),
          applied_at: new Date('2026-08-01T10:20:30.000Z'),
        },
      ],
    ]);

    const output = formatStatus(migrations, applied);
    expect(output).toContain('applied   0001_init');
    expect(output).toContain('PENDING   0002_more');
    expect(output).toContain('2026-08-01T10:20:30.000Z');
    expect(output).toContain('2 migration(s) known, 1 applied, 1 pending.');
  });
});
