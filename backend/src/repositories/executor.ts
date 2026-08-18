/**
 * The one thing every repository in this directory needs: a way to run the same
 * parameterised statement either on the pool or inside a caller's transaction.
 *
 * Two callers want different things. `POST /v1/device/config` runs a single statement and
 * should take a connection, use it, and give it back. `POST /v1/device/enroll` has to
 * consume a token, insert a device and mark the token used *atomically*, so every one of
 * its statements must go through the same `PoolClient` — and with `DB_POOL_MAX = 1`, a
 * repository function that quietly called `query()` while a transaction was open would
 * block forever waiting for the connection its own caller is holding. That failure mode is
 * a hang, not an error, which is the worst kind.
 *
 * So every repository function takes an optional trailing `tx`. Pass it and the statement
 * joins the caller's transaction; omit it and the statement runs on its own. There is no
 * third option and no ambient "current transaction" to forget about.
 */

import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

import type { QuerySpec } from '../shared/db.js';
import { query } from '../shared/db.js';

/**
 * The slice of `PoolClient` a repository is allowed to use. Narrowing it to `query` is
 * deliberate: a repository must not be able to `release()` a connection it did not acquire,
 * or issue its own `commit`.
 */
export type Tx = Pick<PoolClient, 'query'>;

export async function run<T extends QueryResultRow>(
  spec: QuerySpec,
  tx?: Tx,
): Promise<QueryResult<T>> {
  if (tx === undefined) return query<T>(spec);

  // `node-pg` types `values` as a mutable array; QuerySpec keeps it readonly so a caller
  // cannot hand the same array to two statements and mutate it in between.
  return tx.query<T>({ text: spec.text, values: spec.values as unknown[] | undefined });
}

/** Single-row convenience. `undefined` means the statement matched nothing. */
export async function runOne<T extends QueryResultRow>(
  spec: QuerySpec,
  tx?: Tx,
): Promise<T | undefined> {
  const result = await run<T>(spec, tx);
  return result.rows[0];
}
