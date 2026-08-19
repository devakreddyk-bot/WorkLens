/**
 * Writing the audit trail for a dashboard action.
 *
 * `src/repositories/audit.ts` owns the INSERT. This module owns the part that has to be the
 * same everywhere: taking an authenticated `Principal` and a `RequestContext` and turning them
 * into the actor, address and user-agent columns, so no call site has to remember which fields
 * the trail needs and none of them can spell `actor_role` differently.
 *
 * ## Two rules that are the whole point of this file
 *
 * **The write is awaited, and a failure propagates.** Nothing here catches. A `try/catch` around
 * an audit insert converts "we could not record that someone read this employee's screen" into
 * "someone read this employee's screen", silently, which is the exact failure the trail exists
 * to make impossible. Where the audited action is a *read*, the insert therefore runs **before**
 * the data is produced — see `src/handlers/dashboard/reporting.ts`, where the row for a
 * screenshot view is committed before the presigned URL is generated. The trail may run ahead of
 * an access that then failed; it must never run behind one that succeeded.
 *
 * **There is no update and no delete.** `worklens_app` holds `select` and `insert` on
 * `audit_log` and nothing else (migration 0003), so this module has no function to amend an
 * entry. That is not an omission to be filled in later: an amendable trail is not a trail.
 *
 * ## What goes in `metadata`
 *
 * Small, non-sensitive context that makes an entry readable a year later — a date range, a
 * screenshot id, which configuration keys changed. Never a window title, never a token, never a
 * secret. `src/shared/logger.ts` redacts those on the way to CloudWatch; this column has no such
 * filter, because it is a durable record rather than a log line, so the discipline is at the
 * call site.
 */

import type { Principal } from '../middleware/cognitoAuth.js';
import type { AuditActorRole } from '../repositories/audit.js';
import { insertAuditLog } from '../repositories/audit.js';
import type { Tx } from '../repositories/executor.js';
import type { RequestContext } from '../shared/http.js';

/**
 * The dotted verbs this API writes. A closed set rather than free strings so the audit-log
 * filter in the dashboard has something to offer, and so a typo cannot create a category of
 * event that nobody ever queries for.
 */
export const AuditAction = {
  SCREENSHOT_LIST: 'screenshot.list',
  SCREENSHOT_VIEW: 'screenshot.view',
  TIMESHEET_EXPORT: 'timesheet.export',
  AUDIT_LOG_READ: 'audit_log.read',

  EMPLOYEE_CREATE: 'employee.create',
  EMPLOYEE_UPDATE: 'employee.update',

  USER_CREATE: 'user.create',
  USER_UPDATE: 'user.update',

  PROJECT_CREATE: 'project.create',
  PROJECT_UPDATE: 'project.update',
  PROJECT_DEACTIVATE: 'project.deactivate',
  PROJECT_RULE_CREATE: 'project_rule.create',
  PROJECT_RULE_DELETE: 'project_rule.delete',

  CONFIG_UPDATE: 'config.update',

  ENROLLMENT_TOKEN_CREATE: 'enrollment_token.create',
  DEVICE_REVOKE: 'device.revoke',

  DELETION_REQUEST_CREATE: 'deletion_request.create',
  DELETION_REQUEST_EXECUTE: 'deletion_request.execute',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditableAction {
  action: AuditAction;
  /** The kind of thing acted on: `employee`, `screenshot`, `monitoring_config`, … */
  subjectType: string;
  subjectId?: string | undefined;
  /** Set whenever the entry concerns a specific monitored person. Drives the subject index. */
  subjectEmployeeId?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * `audit_log.actor_role` accepts the dashboard roles plus `device` and `system`. A dashboard
 * principal's role maps across unchanged; the cast is a widening, not a conversion.
 */
function actorRole(principal: Principal): AuditActorRole {
  return principal.role;
}

/**
 * Records one action. Throws if the row cannot be written.
 *
 * Pass `tx` to join a caller's transaction — which is what the write paths do, so that the
 * change and the record of who made it commit together or not at all.
 */
export async function recordAudit(
  ctx: RequestContext,
  principal: Principal,
  entry: AuditableAction,
  tx?: Tx,
): Promise<void> {
  await insertAuditLog(
    principal.orgId,
    {
      actorUserId: principal.userId,
      actorEmail: principal.email,
      actorRole: actorRole(principal),
      action: entry.action,
      subjectType: entry.subjectType,
      subjectId: entry.subjectId ?? null,
      subjectEmployeeId: entry.subjectEmployeeId ?? null,
      ip: ctx.sourceIp,
      userAgent: ctx.userAgent,
      metadata: entry.metadata ?? {},
    },
    tx,
  );
}
