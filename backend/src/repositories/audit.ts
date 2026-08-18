/**
 * The audit log — append-only, by grant rather than by convention.
 *
 * `worklens_app` holds `select` and `insert` on `audit_log` and nothing else (migration
 * 0003). There is no `update` and no `delete`, so a bug in a handler, or a compromised
 * handler, cannot rewrite or erase the record of who read whose data. This module has no
 * update or delete function because there is no privilege behind one; adding it would
 * produce a runtime permission error, which is the correct outcome.
 *
 * `actor_email` and `actor_role` are denormalised strings, not joins, so the trail stays
 * readable after a user row is deleted or a role changes. That also makes room for a
 * non-human principal: a device enrolling itself has no `users` row, and the columns can
 * simply say so.
 */

import type { QueryResultRow } from 'pg';

import type { Tx } from './executor.js';
import { run } from './executor.js';

/**
 * Actor roles this file writes. `device` is not a dashboard role — it marks an entry
 * created by an agent acting on its own behalf, where there is no signed-in human.
 */
export type AuditActorRole = 'owner' | 'manager' | 'employee' | 'device' | 'system';

export interface AuditEntry {
  /** Null for a non-human principal; the `users` row otherwise. */
  actorUserId?: string | null | undefined;
  actorEmail: string;
  actorRole: AuditActorRole;
  /** Dotted verb, e.g. `device.enrolled`. Capped at 80 characters by the schema. */
  action: string;
  subjectType: string;
  subjectId?: string | null | undefined;
  /** Set whenever the entry concerns a specific monitored person. */
  subjectEmployeeId?: string | null | undefined;
  ip?: string | null | undefined;
  userAgent?: string | null | undefined;
  /** Small, non-sensitive context. Never a window title, a token, or a secret. */
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Synthesises the `actor_email` for an agent-initiated entry.
 *
 * A device is a real principal that takes real actions, so it gets a real actor rather than
 * a null one — but it must not be mistakable for a person's address. The `device:` prefix
 * plus the device UUID is both unambiguous and joinable back to `devices`.
 */
export function deviceActorEmail(deviceId: string): string {
  return `device:${deviceId}`;
}

/**
 * `ip` is an `inet` column, and a value it cannot parse aborts the statement — which, inside
 * the enrolment transaction, would take the whole enrolment with it. An audit entry losing
 * its source address is a small loss; a device failing to enrol because a proxy put something
 * unexpected in a header is not a trade worth making, so anything that is not a plain address
 * literal is recorded as null.
 */
function normaliseIp(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const candidate = value.trim();
  if (candidate === '' || candidate.length > 45) return null;
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6 = /^[0-9a-f:]+$/i;
  return ipv4.test(candidate) || ipv6.test(candidate) ? candidate : null;
}

export async function insertAuditLog(orgId: string, entry: AuditEntry, tx?: Tx): Promise<void> {
  await run<QueryResultRow>(
    {
      name: 'audit-log-insert',
      text: `insert into audit_log (
                   org_id, actor_user_id, actor_email, actor_role, action,
                   subject_type, subject_id, subject_employee_id, ip, user_agent, metadata
                 )
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9::inet, $10, $11::jsonb)`,
      values: [
        orgId,
        entry.actorUserId ?? null,
        entry.actorEmail,
        entry.actorRole,
        entry.action,
        entry.subjectType,
        entry.subjectId ?? null,
        entry.subjectEmployeeId ?? null,
        normaliseIp(entry.ip),
        entry.userAgent ?? null,
        JSON.stringify(entry.metadata ?? {}),
      ],
    },
    tx,
  );
}
