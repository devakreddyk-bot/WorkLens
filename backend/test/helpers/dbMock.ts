/**
 * A stand-in for `src/shared/db.ts`.
 *
 * The handler tests do not use a database. That is a deliberate choice about what they are
 * for: the failure paths worth pinning — a spent enrolment token, a retried batch, a device
 * over its quota, an idle event carrying a window title — are all decisions the handler makes
 * from a single row, and a live Postgres would add a fixture, a migration run and a container
 * to every one of them without making any of them a better test.
 *
 * So `query`, `queryOne` and `transaction` are replaced and everything else in the module is
 * kept, because `isUniqueViolation` and friends are pure predicates the middleware relies on
 * and there is nothing to gain by faking them.
 *
 * What this *does* let a test assert, and what a repository-level mock would have hidden, is
 * the SQL itself: that the quota really is one `UPDATE`, that the enrolment token really is
 * consumed with `where used_at is null`, and that the losing transaction really rolls back.
 */

import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

import type * as DbModule from '../../src/shared/db.js';
import type { QuerySpec } from '../../src/shared/db.js';

export interface RecordedQuery {
  /** Whitespace-collapsed, so a matcher does not depend on how the SQL is indented. */
  sql: string;
  values: readonly unknown[];
}

type Rows = readonly QueryResultRow[];
type RowsFor = Rows | ((values: readonly unknown[]) => Rows);
type Responder = (sql: string, values: readonly unknown[]) => Rows | undefined;

const responders: Responder[] = [];

/** Every statement issued, in order, across the pool and every transaction. */
export const recorded: RecordedQuery[] = [];

/** Transaction bookkeeping, so a test can assert that a failed enrolment rolled back. */
export const txStats = { started: 0, committed: 0, rolledBack: 0 };

function normalise(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

export function resetDb(): void {
  responders.length = 0;
  recorded.length = 0;
  txStats.started = 0;
  txStats.committed = 0;
  txStats.rolledBack = 0;
}

/**
 * Registers a canned answer for statements whose (normalised) SQL matches.
 *
 * Later registrations take precedence over earlier ones, so a test can register a default in
 * `beforeEach` and override just the statement it is about. An unmatched statement answers with
 * zero rows rather than throwing — which is the honest default, since that is exactly what
 * Postgres does for an `UPDATE` that matches nothing.
 */
export function whenQuery(match: RegExp, rows: RowsFor): void {
  responders.unshift((sql, values) => {
    if (!match.test(sql)) return undefined;
    return typeof rows === 'function' ? rows(values) : rows;
  });
}

export function queriesMatching(match: RegExp): RecordedQuery[] {
  return recorded.filter((entry) => match.test(entry.sql));
}

function toResult<T extends QueryResultRow>(rows: Rows): QueryResult<T> {
  return {
    command: '',
    rowCount: rows.length,
    oid: 0,
    rows: rows as unknown as T[],
    fields: [],
  };
}

function respond<T extends QueryResultRow>(
  sql: string,
  values: readonly unknown[],
): QueryResult<T> {
  const normalised = normalise(sql);
  recorded.push({ sql: normalised, values });

  for (const responder of responders) {
    const rows = responder(normalised, values);
    if (rows !== undefined) return toResult<T>(rows);
  }
  return toResult<T>([]);
}

export function query<T extends QueryResultRow>(spec: QuerySpec): Promise<QueryResult<T>> {
  return Promise.resolve(respond<T>(spec.text, spec.values ?? []));
}

export async function queryOne<T extends QueryResultRow>(
  spec: QuerySpec,
): Promise<T | undefined> {
  const result = await query<T>(spec);
  return result.rows[0];
}

/**
 * A `PoolClient` that only knows how to answer queries. Narrow on purpose: if a repository ever
 * reaches for `release()` or issues its own `commit`, this fails loudly instead of quietly
 * doing something the real transaction wrapper would not have allowed.
 */
const txClient = {
  query: (specOrText: unknown, values?: unknown[]): Promise<QueryResult<QueryResultRow>> => {
    if (typeof specOrText === 'string') {
      return Promise.resolve(respond(specOrText, values ?? []));
    }
    const spec = specOrText as QuerySpec;
    return Promise.resolve(respond(spec.text, spec.values ?? []));
  },
} as unknown as PoolClient;

export async function transaction<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  txStats.started += 1;
  try {
    const result = await fn(txClient);
    txStats.committed += 1;
    return result;
  } catch (err) {
    txStats.rolledBack += 1;
    throw err;
  }
}

/**
 * The `vi.mock` factory itself, so the five handler test files share one spelling of it.
 *
 * `importOriginal` is awaited *after* this module has been imported, which matters: evaluating
 * `src/shared/db.ts` pulls in `src/shared/config.ts`, and that validates the environment at load
 * time. `test/setup.ts` has already run by then, so the ordering works either way — but keeping
 * the real module's evaluation inside the factory means a test file never has a reason to import
 * it directly.
 *
 * Use it as:
 *
 *     vi.mock('../../src/shared/db.js', async (importOriginal) =>
 *       (await import('../helpers/dbMock.js')).dbMockFactory(importOriginal));
 */
export async function dbMockFactory(
  importOriginal: <T>() => Promise<T>,
): Promise<typeof DbModule> {
  const actual = await importOriginal<typeof DbModule>();
  return { ...actual, query, queryOne, transaction };
}
