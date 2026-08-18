/**
 * Enrolment token consumption.
 *
 * A token is single-use and the enforcement of that is the only interesting thing in this
 * file. Two operators running `agentctl enroll --token wlen_...` at the same moment with the
 * same token must produce exactly one device, and the loser must be told the token is spent
 * rather than quietly handed a second set of credentials for the same employee.
 *
 * The lookup here does *not* take an `org_id`: establishing which organisation a token
 * belongs to is what the lookup is for, and there is no authenticated caller at enrolment
 * time to take one from. Everything after the lookup is org-scoped.
 */

import type { Tx } from './executor.js';
import { runOne } from './executor.js';

export interface EnrollmentTokenRow {
  id: string;
  org_id: string;
  employee_id: string;
  expires_at: Date;
  used_at: Date | null;
}

/**
 * The three distinguishable failures, kept separate because they mean different things to
 * the operator holding the token: an unknown token is a typo, an expired one needs a new
 * token issued, and an already-used one usually means the device is already enrolled and
 * someone is re-running the command.
 */
export type EnrollmentTokenLookup =
  | { status: 'usable'; token: EnrollmentTokenRow }
  | { status: 'not_found' }
  | { status: 'expired'; token: EnrollmentTokenRow }
  | { status: 'used'; token: EnrollmentTokenRow };

/**
 * Finds a token by the SHA-256 of the string the operator presented.
 *
 * The token itself is never stored, so this is a lookup on `token_hash`, which is unique.
 * Expiry is evaluated in the database rather than against the Lambda's clock — there is
 * exactly one clock that should decide whether a credential is still valid, and it is not
 * the one on whichever container happened to serve the request.
 */
export async function lookupEnrollmentToken(
  tokenHash: Buffer,
  tx?: Tx,
): Promise<EnrollmentTokenLookup> {
  const row = await runOne<EnrollmentTokenRow & { expired: boolean }>(
    {
      name: 'enrollment-token-lookup',
      text: `select id, org_id, employee_id, expires_at, used_at,
                    (expires_at <= now()) as expired
               from enrollment_tokens
              where token_hash = $1`,
      values: [tokenHash],
    },
    tx,
  );

  if (row === undefined) return { status: 'not_found' };

  const token: EnrollmentTokenRow = {
    id: row.id,
    org_id: row.org_id,
    employee_id: row.employee_id,
    expires_at: row.expires_at,
    used_at: row.used_at,
  };

  // Already-used is reported ahead of expired: a token that was used and has since expired
  // is more usefully described as "already enrolled" than as "too old".
  if (token.used_at !== null) return { status: 'used', token };
  if (row.expired) return { status: 'expired', token };
  return { status: 'usable', token };
}

/**
 * Marks the token used and binds it to the device that consumed it.
 *
 * `where used_at is null` is what makes this safe, and it has to be re-checked by the
 * database rather than by the caller: the lookup above happened in a snapshot, and between
 * that snapshot and this statement a concurrent enrolment may have committed. Postgres
 * blocks the second `UPDATE` on the row lock, then re-evaluates the predicate against the
 * committed row, finds `used_at` set, and matches nothing.
 *
 * Returning `false` therefore means "another enrolment won". The caller runs inside a
 * transaction and must abort, which discards the device row it had already inserted — so
 * the losing request leaves nothing behind.
 *
 * Both columns move together because `enrollment_tokens_used_chk` requires it, which also
 * means the device must already exist when this runs: `used_by_device_id` is a foreign key.
 */
export async function markEnrollmentTokenUsed(
  orgId: string,
  tokenId: string,
  deviceId: string,
  tx?: Tx,
): Promise<boolean> {
  const row = await runOne<{ id: string }>(
    {
      name: 'enrollment-token-consume',
      text: `update enrollment_tokens
                set used_at = now(),
                    used_by_device_id = $3
              where org_id = $1
                and id = $2
                and used_at is null
          returning id`,
      values: [orgId, tokenId, deviceId],
    },
    tx,
  );

  return row !== undefined;
}
