/**
 * `admin-api` — every dashboard write, plus the reads that only an owner may make.
 *
 * The split from `reporting-api` is by *privilege*, not by HTTP verb. `GET /v1/config` and
 * `GET /v1/audit-log` are reads, and they live here because they belong to the same blast radius
 * as the writes beside them: the monitoring configuration decides what is collected from
 * employees' laptops, and the audit trail names everyone who has looked at whose data. Keeping
 * them in a function whose execution role can also delete S3 objects is deliberate — one role,
 * one set of permissions, one thing to review.
 *
 * ## Every route here is owner-only, and every one is behind MFA
 *
 * `POLICY.ownerWrite` is `{ roles: ['owner'], adminScoped: true }`, so a `manager` is refused
 * outright (docs/PLAN.md §4: managers read all employees, no settings and no user management) and
 * an owner without a configured second factor is refused with `MFA_REQUIRED` (D7). Both are
 * enforced in `authorizeRoute`, from the policy attached to the route, before any handler runs.
 *
 * ## Writes and their audit rows commit together
 *
 * Each mutating route runs inside one transaction that contains both the change and the
 * `audit_log` insert. That is stronger than "audit afterwards": a change that committed while its
 * audit row was lost is an unattributable change to what is collected from people, and a
 * transaction is the only way to make that state unreachable rather than merely unlikely.
 */

import { createHash, randomBytes } from 'node:crypto';

import { DeleteObjectsCommand, S3Client } from '@aws-sdk/client-s3';

import { addLocalDays, startOfLocalDay } from '../../aggregation/zone.js';

import { AuditAction, recordAudit } from '../../middleware/audit.js';
import type { Principal, RouteParams } from '../../middleware/cognitoAuth.js';
import { POLICY, createDashboardRouter } from '../../middleware/cognitoAuth.js';
import { revokeDevice } from '../../repositories/devices.js';
import type { NullableSet } from '../../repositories/employees.js';
import {
  DELETION_BATCH_SIZE,
  claimDeletionRequest,
  deactivateProject,
  deleteActivityEventBatch,
  deleteProjectRule,
  deleteScreenshotRows,
  finishDeletionRequest,
  getProject,
  getUser,
  insertDeletionRequest,
  insertEmployee,
  insertEnrollmentToken,
  insertProject,
  insertProjectRule,
  insertUser,
  listDeletionRequests,
  listDevices,
  listProjectRules,
  listProjects,
  listUsers,
  selectScreenshotBatch,
  updateEmployee,
  updateMonitoringConfig,
  updateProject,
  updateUser,
} from '../../repositories/employees.js';
import {
  getMonitoringConfig,
  presentMonitoringConfig,
} from '../../repositories/monitoringConfig.js';
import { encodeCursor, getOrganization, listAuditLog } from '../../repositories/reporting.js';
import {
  auditLogQuery,
  createDeletionRequestBody,
  createEmployeeBody,
  createEnrollmentTokenBody,
  createProjectBody,
  createProjectRuleBody,
  createUserBody,
  parseQuery,
  updateConfigBody,
  updateEmployeeBody,
  updateProjectBody,
  updateUserBody,
} from '../../schemas/dashboard.js';
import { parseBody } from '../../schemas/parse.js';
import { config } from '../../shared/config.js';
import { isCheckViolation, isUniqueViolation, transaction } from '../../shared/db.js';
import { AppError, ErrorCode, errors } from '../../shared/errors.js';
import type { JsonResponse, RequestContext } from '../../shared/http.js';
import { created, ok, parseJsonBody, withHandler } from '../../shared/http.js';

/** Module scope so a warm container reuses the client. Reached via the S3 gateway endpoint. */
const s3 = new S3Client({ region: config.AWS_REGION });

/** Page ceilings for the administrative lists. Bounded for the same reason every list is. */
const DEVICE_LIST_LIMIT = 500;
const DELETION_LIST_LIMIT = 200;

/** `DeleteObjects` accepts at most 1 000 keys per call. */
const S3_DELETE_BATCH = 1000;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Turns a Postgres constraint failure into the right 4xx.
 *
 * Mapping by constraint *name* rather than by message text: messages are localised and change
 * between versions, and the whole point of naming these constraints in `0001_init.sql` was so the
 * application could react to them by name.
 */
function conflictOf(err: unknown, what: string): AppError | undefined {
  if (isUniqueViolation(err)) {
    return new AppError(ErrorCode.CONFLICT, `${what} already exists.`, {
      logContext: { reason: 'unique_violation' },
    });
  }
  if (isCheckViolation(err)) {
    return new AppError(ErrorCode.CONFLICT, `${what} is not a valid combination of values.`, {
      logContext: { reason: 'check_violation' },
    });
  }
  return undefined;
}

async function withConflictMapping<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const mapped = conflictOf(err, what);
    if (mapped !== undefined) throw mapped;
    throw err;
  }
}

/**
 * Reads an optional-and-nullable field out of a validated patch body.
 *
 * `'external_ref' in body` is the only way to tell "the caller did not mention this" from "the
 * caller asked to clear it", and with `exactOptionalPropertyTypes` those are genuinely different
 * inputs that must produce different SQL. See `NullableSet` in the repository.
 */
function nullableSet<T>(
  body: Record<string, unknown>,
  key: string,
): NullableSet<T> | undefined {
  if (!(key in body)) return undefined;
  return { value: (body[key] ?? null) as T | null };
}

function pathParam(params: RouteParams, name: string, what: string): string {
  const value: string | undefined = params[name];
  if (value === undefined || value === '') throw errors.notFound(what);
  return value;
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

async function createEmployee(ctx: RequestContext, principal: Principal): Promise<JsonResponse> {
  const body = parseBody(createEmployeeBody, parseJsonBody(ctx));

  const organization = await getOrganization(principal.orgId);
  if (organization === undefined) {
    throw errors.internal(new Error('token names an organisation that does not exist'), {
      orgId: principal.orgId,
    });
  }

  const employee = await withConflictMapping('An employee with that email address', () =>
    transaction(async (tx) => {
      const row = await insertEmployee(
        principal.orgId,
        {
          fullName: body.full_name,
          email: body.email,
          externalRef: body.external_ref ?? null,
          // Defaults to the organisation's zone rather than to UTC: an employee whose timesheet
          // days were cut in UTC would see their evening work land on tomorrow.
          timezone: body.timezone ?? organization.timezone,
          status: body.status,
          hiredOn: body.hired_on ?? null,
        },
        tx,
      );

      await recordAudit(
        ctx,
        principal,
        {
          action: AuditAction.EMPLOYEE_CREATE,
          subjectType: 'employee',
          subjectId: row.id,
          subjectEmployeeId: row.id,
          metadata: { timezone: row.timezone, status: row.status },
        },
        tx,
      );

      return row;
    }),
  );

  return created({ employee });
}

async function patchEmployee(
  ctx: RequestContext,
  principal: Principal,
  params: RouteParams,
): Promise<JsonResponse> {
  const employeeId = pathParam(params, 'id', 'Employee');
  const raw = parseJsonBody(ctx) as Record<string, unknown>;
  const body = parseBody(updateEmployeeBody, raw);

  const employee = await withConflictMapping('An employee with that email address', () =>
    transaction(async (tx) => {
      const row = await updateEmployee(
        principal.orgId,
        employeeId,
        {
          ...(body.full_name === undefined ? {} : { fullName: body.full_name }),
          ...(body.email === undefined ? {} : { email: body.email }),
          ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
          ...(body.status === undefined ? {} : { status: body.status }),
          ...(() => {
            const externalRef = nullableSet<string>(raw, 'external_ref');
            return externalRef === undefined ? {} : { externalRef };
          })(),
          ...(() => {
            const hiredOn = nullableSet<string>(raw, 'hired_on');
            return hiredOn === undefined ? {} : { hiredOn };
          })(),
        },
        tx,
      );

      if (row === undefined) return undefined;

      await recordAudit(
        ctx,
        principal,
        {
          action: AuditAction.EMPLOYEE_UPDATE,
          subjectType: 'employee',
          subjectId: row.id,
          subjectEmployeeId: row.id,
          // Field names only. The values are personal data and the audit row is not the place
          // to keep a second copy of them.
          metadata: { fields: Object.keys(raw).sort() },
        },
        tx,
      );

      return row;
    }),
  );

  if (employee === undefined) throw errors.notFound('Employee');
  return ok({ employee });
}

// ---------------------------------------------------------------------------
// Dashboard users
// ---------------------------------------------------------------------------

async function getUsers(_ctx: RequestContext, principal: Principal): Promise<JsonResponse> {
  const users = await listUsers(principal.orgId);
  /**
   * No MFA column. `users` has none, and there is nowhere to put one: whether a factor is
   * configured lives in Cognito and reaches this API only as the `wl:mfa` claim on the *caller's*
   * own token. Reporting it for other people would need `AdminGetUser` per row, and `admin-api`
   * holds no `cognito-idp` permission (`infra/modules/lambda/main.tf`). The settings screen shows
   * the role and status; MFA state is visible in the Cognito console.
   */
  return ok({ users, count: users.length });
}

async function createDashboardUser(
  ctx: RequestContext,
  principal: Principal,
): Promise<JsonResponse> {
  const body = parseBody(createUserBody, parseJsonBody(ctx));

  const user = await withConflictMapping('A user with that email address or Cognito subject', () =>
    transaction(async (tx) => {
      const row = await insertUser(
        principal.orgId,
        {
          cognitoSub: body.cognito_sub,
          email: body.email,
          role: body.role,
          employeeId: body.employee_id ?? null,
          status: body.status,
        },
        tx,
      );

      if (row === undefined) return undefined;

      await recordAudit(
        ctx,
        principal,
        {
          action: AuditAction.USER_CREATE,
          subjectType: 'user',
          subjectId: row.id,
          subjectEmployeeId: row.employee_id,
          metadata: { role: row.role, status: row.status },
        },
        tx,
      );

      return row;
    }),
  );

  // `undefined` here means the employee named by `employee_id` is not this organisation's — the
  // insert's `exists` guard matched nothing. Reported as a 404 on that employee rather than a 409,
  // because from the caller's side the employee is what does not exist.
  if (user === undefined) throw errors.notFound('Employee');
  return created({ user });
}

async function patchDashboardUser(
  ctx: RequestContext,
  principal: Principal,
  params: RouteParams,
): Promise<JsonResponse> {
  const userId = pathParam(params, 'id', 'User');
  const raw = parseJsonBody(ctx) as Record<string, unknown>;
  const body = parseBody(updateUserBody, raw);

  // An owner removing their own owner role, or disabling their own account, locks the
  // organisation out of every route in this file — there is no other way back in, because user
  // management is owner-only. Refused rather than warned about.
  if (userId === principal.userId && (body.role !== undefined || body.status !== undefined)) {
    throw errors.forbidden({ reason: 'self_role_or_status_change', userId });
  }

  const existing = await getUser(principal.orgId, userId);
  if (existing === undefined) throw errors.notFound('User');

  const user = await withConflictMapping('That user', () =>
    transaction(async (tx) => {
      const row = await updateUser(
        principal.orgId,
        userId,
        {
          ...(body.role === undefined ? {} : { role: body.role }),
          ...(body.status === undefined ? {} : { status: body.status }),
          ...(() => {
            const employeeId = nullableSet<string>(raw, 'employee_id');
            return employeeId === undefined ? {} : { employeeId };
          })(),
        },
        tx,
      );

      if (row === undefined) return undefined;

      await recordAudit(
        ctx,
        principal,
        {
          action: AuditAction.USER_UPDATE,
          subjectType: 'user',
          subjectId: row.id,
          subjectEmployeeId: row.employee_id,
          metadata: { fields: Object.keys(raw).sort(), role: row.role, status: row.status },
        },
        tx,
      );

      return row;
    }),
  );

  // The row exists, so a miss means the employee link named an employee outside the organisation.
  if (user === undefined) throw errors.notFound('Employee');
  return ok({ user });
}

// ---------------------------------------------------------------------------
// Projects and rules
// ---------------------------------------------------------------------------

async function getProjects(ctx: RequestContext, principal: Principal): Promise<JsonResponse> {
  // Inactive projects are included: this is the management view, and a retired project still owns
  // historical timesheet totals that have to be explainable.
  const projects = await listProjects(principal.orgId, true);
  ctx.log.debug('projects listed', { count: projects.length });
  return ok({ projects, count: projects.length });
}

async function createProjectRoute(
  ctx: RequestContext,
  principal: Principal,
): Promise<JsonResponse> {
  const body = parseBody(createProjectBody, parseJsonBody(ctx));

  const project = await withConflictMapping('A project with that name', () =>
    transaction(async (tx) => {
      const row = await insertProject(
        principal.orgId,
        { name: body.name, code: body.code ?? null, isActive: body.is_active },
        tx,
      );

      await recordAudit(
        ctx,
        principal,
        {
          action: AuditAction.PROJECT_CREATE,
          subjectType: 'project',
          subjectId: row.id,
          metadata: { name: row.name },
        },
        tx,
      );

      return row;
    }),
  );

  return created({ project });
}

async function patchProject(
  ctx: RequestContext,
  principal: Principal,
  params: RouteParams,
): Promise<JsonResponse> {
  const projectId = pathParam(params, 'id', 'Project');
  const raw = parseJsonBody(ctx) as Record<string, unknown>;
  const body = parseBody(updateProjectBody, raw);

  const project = await withConflictMapping('A project with that name', () =>
    transaction(async (tx) => {
      const row = await updateProject(
        principal.orgId,
        projectId,
        {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.is_active === undefined ? {} : { isActive: body.is_active }),
          ...(() => {
            const code = nullableSet<string>(raw, 'code');
            return code === undefined ? {} : { code };
          })(),
        },
        tx,
      );

      if (row === undefined) return undefined;

      await recordAudit(
        ctx,
        principal,
        {
          action: AuditAction.PROJECT_UPDATE,
          subjectType: 'project',
          subjectId: row.id,
          metadata: { fields: Object.keys(raw).sort() },
        },
        tx,
      );

      return row;
    }),
  );

  if (project === undefined) throw errors.notFound('Project');
  return ok({ project });
}

/**
 * `DELETE /v1/projects/{id}` retires the project instead of deleting the row.
 *
 * `timesheet_project_totals` cascades from `projects` and `activity_events.project_id` is
 * `on delete set null`, so a real delete would rewrite history: every past per-project breakdown
 * for that project would vanish and a payroll export run last month would stop reproducing.
 * `projects.is_active` exists so a project can stop being offered without any of that, so that is
 * what this does — and the response says `deactivated` rather than reporting a deletion that did
 * not happen.
 */
async function removeProject(
  ctx: RequestContext,
  principal: Principal,
  params: RouteParams,
): Promise<JsonResponse> {
  const projectId = pathParam(params, 'id', 'Project');

  const project = await transaction(async (tx) => {
    const row = await deactivateProject(principal.orgId, projectId, tx);
    if (row === undefined) return undefined;

    await recordAudit(
      ctx,
      principal,
      {
        action: AuditAction.PROJECT_DEACTIVATE,
        subjectType: 'project',
        subjectId: row.id,
        metadata: { name: row.name },
      },
      tx,
    );

    return row;
  });

  if (project === undefined) throw errors.notFound('Project');
  return ok({
    project,
    deactivated: true,
    detail:
      'The project was deactivated rather than deleted, so historical timesheet totals that ' +
      'reference it remain intact.',
  });
}

async function getProjectRules(
  _ctx: RequestContext,
  principal: Principal,
  params: RouteParams,
): Promise<JsonResponse> {
  const projectId = pathParam(params, 'id', 'Project');

  const project = await getProject(principal.orgId, projectId);
  if (project === undefined) throw errors.notFound('Project');

  const rules = await listProjectRules(principal.orgId, projectId);
  return ok({ project_id: projectId, rules, count: rules.length });
}

async function createProjectRuleRoute(
  ctx: RequestContext,
  principal: Principal,
  params: RouteParams,
): Promise<JsonResponse> {
  const projectId = pathParam(params, 'id', 'Project');
  const body = parseBody(createProjectRuleBody, parseJsonBody(ctx));

  const rule = await withConflictMapping('That rule', () =>
    transaction(async (tx) => {
      const row = await insertProjectRule(
        principal.orgId,
        projectId,
        { matchType: body.match_type, pattern: body.pattern, priority: body.priority },
        tx,
      );

      if (row === undefined) return undefined;

      await recordAudit(
        ctx,
        principal,
        {
          action: AuditAction.PROJECT_RULE_CREATE,
          subjectType: 'project_rule',
          subjectId: row.id,
          metadata: { project_id: projectId, match_type: row.match_type, priority: row.priority },
        },
        tx,
      );

      return row;
    }),
  );

  if (rule === undefined) throw errors.notFound('Project');
  return created({ rule });
}

async function removeProjectRule(
  ctx: RequestContext,
  principal: Principal,
  params: RouteParams,
): Promise<JsonResponse> {
  const projectId = pathParam(params, 'id', 'Project');
  const ruleId = pathParam(params, 'rid', 'Project rule');

  const rule = await transaction(async (tx) => {
    const row = await deleteProjectRule(principal.orgId, projectId, ruleId, tx);
    if (row === undefined) return undefined;

    await recordAudit(
      ctx,
      principal,
      {
        action: AuditAction.PROJECT_RULE_DELETE,
        subjectType: 'project_rule',
        subjectId: row.id,
        metadata: { project_id: projectId, match_type: row.match_type },
      },
      tx,
    );

    return row;
  });

  if (rule === undefined) throw errors.notFound('Project rule');
  return ok({ rule, deleted: true });
}

// ---------------------------------------------------------------------------
// Monitoring configuration
// ---------------------------------------------------------------------------

async function getConfig(_ctx: RequestContext, principal: Principal): Promise<JsonResponse> {
  const row = await getMonitoringConfig(principal.orgId);
  if (row === undefined) {
    // Seeded by `wl_seed_org_defaults()` when the organisation is created, so its absence is a
    // bootstrap failure rather than a client error.
    throw errors.internal(new Error('organisation has no monitoring_config row'), {
      orgId: principal.orgId,
    });
  }

  return ok({ config: presentMonitoringConfig(row), config_version: row.config_version });
}

/**
 * The keys whose values differ between the stored row and the submitted body.
 *
 * Recorded in the audit entry because "the configuration changed" is not a useful record of what
 * an owner did to what is collected from people's laptops — "screenshot_enabled and
 * excluded_apps changed" is. Values are deliberately not recorded here; the full before-and-after
 * is reconstructable from the version history of the row plus the settings screen's own diff
 * dialog, and the exclusion lists can contain host names an employee typed.
 */
function changedConfigKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const changed: string[] = [];
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed.push(key);
  }
  return changed.sort();
}

async function putConfig(ctx: RequestContext, principal: Principal): Promise<JsonResponse> {
  const body = parseBody(updateConfigBody, parseJsonBody(ctx));

  const result = await withConflictMapping('That monitoring configuration', () =>
    transaction(async (tx) => {
      const before = await getMonitoringConfig(principal.orgId, tx);
      if (before === undefined) return undefined;

      const updated = await updateMonitoringConfig(
        principal.orgId,
        {
          sampleIntervalSeconds: body.sample_interval_seconds,
          idleThresholdSeconds: body.idle_threshold_seconds,
          captureWindowTitles: body.capture_window_titles,
          captureUrls: body.capture_urls,
          screenshotEnabled: body.screenshot_enabled,
          screenshotIntervalSeconds: body.screenshot_interval_seconds,
          screenshotBlur: body.screenshot_blur,
          workHoursOnly: body.work_hours_only,
          workHoursStart: body.work_hours_start,
          workHoursEnd: body.work_hours_end,
          workDays: body.work_days,
          excludedApps: body.excluded_apps,
          excludedUrlPatterns: body.excluded_url_patterns,
          retentionDaysEvents: body.retention_days_events,
          retentionDaysScreenshots: body.retention_days_screenshots,
        },
        principal.userId,
        tx,
      );

      if (updated === undefined) return undefined;

      const changed = changedConfigKeys(
        { ...presentMonitoringConfig(before) },
        { ...body },
      );

      await recordAudit(
        ctx,
        principal,
        {
          action: AuditAction.CONFIG_UPDATE,
          subjectType: 'monitoring_config',
          subjectId: principal.orgId,
          metadata: {
            config_version: updated.config_version,
            changed_keys: changed,
            // Called out separately because these three are the settings that change what is
            // collected from an employee's machine, and they are the ones a reader of the trail
            // will be looking for.
            screenshot_enabled: body.screenshot_enabled,
            capture_urls: body.capture_urls,
            capture_window_titles: body.capture_window_titles,
          },
        },
        tx,
      );

      const after = await getMonitoringConfig(principal.orgId, tx);
      return after === undefined ? undefined : { row: after, changed };
    }),
  );

  if (result === undefined) {
    throw errors.internal(new Error('organisation has no monitoring_config row'), {
      orgId: principal.orgId,
    });
  }

  ctx.log.info('monitoring configuration updated', {
    configVersion: result.row.config_version,
    changedKeys: result.changed,
  });

  return ok({
    config: presentMonitoringConfig(result.row),
    config_version: result.row.config_version,
    changed_keys: result.changed,
  });
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

async function getDevices(_ctx: RequestContext, principal: Principal): Promise<JsonResponse> {
  const devices = await listDevices(principal.orgId, DEVICE_LIST_LIMIT);
  return ok({ devices, count: devices.length });
}

/**
 * `POST /v1/devices/enrollment-tokens` — mint a single-use enrolment token.
 *
 * The token is `wlen_` plus 32 bytes from a CSPRNG, and only its SHA-256 is stored: the value in
 * this response is the only time it exists anywhere outside the operator's terminal. That is why
 * the response says so explicitly — a caller that assumes it can be re-read later will build a
 * flow that silently cannot work.
 *
 * The token is *not* written to the log, at any level, and the audit entry records the token's row
 * id rather than the token. A credential that mints device credentials belongs in exactly one
 * place: the response body.
 */
async function createEnrollmentToken(
  ctx: RequestContext,
  principal: Principal,
): Promise<JsonResponse> {
  const body = parseBody(createEnrollmentTokenBody, parseJsonBody(ctx));

  const token = `wlen_${randomBytes(32).toString('base64url')}`;
  const tokenHash = createHash('sha256').update(token, 'utf8').digest();

  const issued = await transaction(async (tx) => {
    const row = await insertEnrollmentToken(
      principal.orgId,
      body.employee_id,
      tokenHash,
      body.expires_in_hours,
      principal.userId,
      tx,
    );

    if (row === undefined) return undefined;

    await recordAudit(
      ctx,
      principal,
      {
        action: AuditAction.ENROLLMENT_TOKEN_CREATE,
        subjectType: 'enrollment_token',
        subjectId: row.id,
        subjectEmployeeId: row.employee_id,
        metadata: {
          expires_at: row.expires_at.toISOString(),
          expires_in_hours: body.expires_in_hours,
        },
      },
      tx,
    );

    return row;
  });

  // The insert selects from `employees` scoped to this organisation and to `status = 'active'`, so
  // a miss means either the employee is not this organisation's or they are inactive. Both are
  // reported the same way: an inactive employee should not be receiving a new monitored laptop.
  if (issued === undefined) throw errors.notFound('Active employee');

  return created({
    enrollment_token_id: issued.id,
    employee_id: issued.employee_id,
    token,
    expires_at: issued.expires_at.toISOString(),
    detail:
      'This token is shown once and is not recoverable. Run ' +
      '`worklens-agentctl enroll --token <token>` on the device before it expires.',
  });
}

async function revokeDeviceRoute(
  ctx: RequestContext,
  principal: Principal,
  params: RouteParams,
): Promise<JsonResponse> {
  const deviceId = pathParam(params, 'id', 'Device');

  const device = await transaction(async (tx) => {
    const row = await revokeDevice(principal.orgId, deviceId, tx);
    if (row === undefined) return undefined;

    await recordAudit(
      ctx,
      principal,
      {
        action: AuditAction.DEVICE_REVOKE,
        subjectType: 'device',
        subjectId: row.id,
        subjectEmployeeId: row.employee_id,
        metadata: { revoked_at: row.revoked_at.toISOString() },
      },
      tx,
    );

    return row;
  });

  if (device === undefined) throw errors.notFound('Device');

  // `revokeDevice` uses `coalesce(revoked_at, now())`, so re-revoking keeps the original moment —
  // the one that matters if anyone has to reconstruct when a laptop stopped being trusted.
  return ok({
    device_id: device.id,
    employee_id: device.employee_id,
    revoked_at: device.revoked_at.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/**
 * `GET /v1/audit-log`.
 *
 * Reading the trail is itself audited. That is not circular busywork: the question "who has been
 * reviewing who has been looking at whose data" has an answer, and without this entry it would
 * not. The read cannot be hidden either, because `worklens_app` has no `delete` on this table.
 */
async function getAuditLog(ctx: RequestContext, principal: Principal): Promise<JsonResponse> {
  const query = parseQuery(auditLogQuery, ctx);

  const organization = await getOrganization(principal.orgId);
  const timezone = organization?.timezone ?? principal.timezone;

  await recordAudit(ctx, principal, {
    action: AuditAction.AUDIT_LOG_READ,
    subjectType: 'audit_log',
    subjectId: principal.orgId,
    ...(query.employee_id === undefined ? {} : { subjectEmployeeId: query.employee_id }),
    metadata: {
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.to === undefined ? {} : { to: query.to }),
      ...(query.action === undefined ? {} : { action_filter: query.action }),
    },
  });

  // The date filters are calendar dates in the organisation's timezone, converted to instants
  // here: `created_at` is a `timestamptz`, and comparing it against a bare date would silently
  // apply UTC boundaries to an Indian working day.
  const from = query.from === undefined ? undefined : startOfLocalDay(query.from, timezone);
  // Exclusive upper bound at the start of the day *after* `to`, so a filter of `to=2026-08-18`
  // includes everything that happened on the 18th rather than stopping at its midnight.
  const to =
    query.to === undefined ? undefined : startOfLocalDay(addLocalDays(query.to, 1), timezone);

  const entries = await listAuditLog(principal.orgId, {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(query.action === undefined ? {} : { action: query.action }),
    ...(query.employee_id === undefined ? {} : { employeeId: query.employee_id }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    limit: query.limit,
  });

  const last = entries[entries.length - 1];
  const nextCursor =
    entries.length === query.limit && last !== undefined
      ? encodeCursor(last.created_at, last.id)
      : null;

  return ok({
    entries: entries.map((entry) => ({
      id: entry.id,
      created_at: entry.created_at.toISOString(),
      actor_user_id: entry.actor_user_id,
      actor_email: entry.actor_email,
      actor_role: entry.actor_role,
      action: entry.action,
      subject_type: entry.subject_type,
      subject_id: entry.subject_id,
      subject_employee_id: entry.subject_employee_id,
      subject_employee_name: entry.subject_employee_name,
      ip: entry.ip,
      user_agent: entry.user_agent,
      metadata: entry.metadata,
    })),
    count: entries.length,
    next_cursor: nextCursor,
  });
}

// ---------------------------------------------------------------------------
// Data deletion
// ---------------------------------------------------------------------------

async function getDeletionRequests(
  _ctx: RequestContext,
  principal: Principal,
): Promise<JsonResponse> {
  const requests = await listDeletionRequests(principal.orgId, DELETION_LIST_LIMIT);
  return ok({ deletion_requests: requests, count: requests.length });
}

async function createDeletionRequest(
  ctx: RequestContext,
  principal: Principal,
): Promise<JsonResponse> {
  const body = parseBody(createDeletionRequestBody, parseJsonBody(ctx));

  const request = await transaction(async (tx) => {
    const row = await insertDeletionRequest(
      principal.orgId,
      {
        employeeId: body.employee_id,
        scope: body.scope,
        requestedByUserId: principal.userId,
        reason: body.reason ?? null,
      },
      tx,
    );

    if (row === undefined) return undefined;

    await recordAudit(
      ctx,
      principal,
      {
        action: AuditAction.DELETION_REQUEST_CREATE,
        subjectType: 'data_deletion_request',
        subjectId: row.id,
        subjectEmployeeId: row.employee_id,
        metadata: { scope: row.scope },
      },
      tx,
    );

    return row;
  });

  if (request === undefined) throw errors.notFound('Employee');
  return created({ deletion_request: request });
}

/** Deletes objects from S3 in batches, grouped by the bucket each row names. */
async function deleteObjects(rows: readonly { s3_bucket: string; s3_key: string }[]): Promise<void> {
  const byBucket = new Map<string, string[]>();
  for (const row of rows) {
    const keys = byBucket.get(row.s3_bucket) ?? [];
    keys.push(row.s3_key);
    byBucket.set(row.s3_bucket, keys);
  }

  for (const [bucket, keys] of byBucket) {
    for (let index = 0; index < keys.length; index += S3_DELETE_BATCH) {
      const slice = keys.slice(index, index + S3_DELETE_BATCH);
      const response = await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: slice.map((key) => ({ Key: key })), Quiet: true },
        }),
      );

      // A per-key failure is reported in the response body, not as a thrown error. Ignoring it
      // would mean reporting a completed erasure while the images are still in the bucket, which
      // is the one lie this endpoint must not tell.
      const failures = response.Errors ?? [];
      if (failures.length > 0) {
        throw new Error(
          `S3 refused to delete ${failures.length} of ${slice.length} screenshot objects ` +
            `(first code: ${failures[0]?.Code ?? 'unknown'})`,
        );
      }
    }
  }
}

/**
 * `POST /v1/deletion-requests/{id}/execute` — the hard delete.
 *
 * ## Ordering: objects before rows
 *
 * Each screenshot batch has its S3 objects deleted *before* its database rows. The reverse order
 * loses the only record of which objects to remove, so a crash between the two would leave
 * screenshots of an employee's screen in the bucket with nothing in the database pointing at them
 * — invisible to the retention sweeper, invisible to this endpoint on a retry, and still there.
 * `DeleteObjects` is idempotent, so re-running after a failure is safe; the request stays
 * `pending` until the whole thing succeeds.
 *
 * ## Why the transaction spans the S3 calls
 *
 * Holding a database transaction across a network call is normally a mistake, and with
 * `DB_POOL_MAX = 1` it occupies the container's only connection for the duration. It is the right
 * trade here: the alternative is committing row deletions before the bytes are gone, which is the
 * failure described above. This is a rare, deliberate, owner-initiated operation with a 30 second
 * function timeout, and nothing else depends on it finishing quickly.
 *
 * ## What is deliberately not deleted
 *
 * The `audit_log` rows describing this erasure and the accesses that preceded it. That is stated in
 * `docs/RESPONSIBLE_USE.md` and is not an oversight: a deletion you cannot evidence is worse than
 * no deletion at all. `worklens_app` also has no `delete` on that table, so the choice is enforced
 * by grant rather than by intention.
 */
async function executeDeletionRequest(
  ctx: RequestContext,
  principal: Principal,
  params: RouteParams,
): Promise<JsonResponse> {
  const requestId = pathParam(params, 'id', 'Deletion request');

  const outcome = await transaction(async (tx) => {
    const claimed = await claimDeletionRequest(principal.orgId, requestId, tx);
    if (claimed === undefined) return { kind: 'not_found' as const };

    if (claimed.status !== 'pending') {
      return { kind: 'already_finished' as const, status: claimed.status };
    }

    const deleteEvents = claimed.scope === 'all' || claimed.scope === 'events';
    const deleteScreenshots = claimed.scope === 'all' || claimed.scope === 'screenshots';

    let deletedEvents = 0;
    let deletedScreenshots = 0;

    if (deleteScreenshots) {
      for (;;) {
        const batch = await selectScreenshotBatch(principal.orgId, claimed.employee_id, tx);
        if (batch.length === 0) break;

        await deleteObjects(batch);
        deletedScreenshots += await deleteScreenshotRows(
          principal.orgId,
          batch.map((row) => row.id),
          tx,
        );

        if (batch.length < DELETION_BATCH_SIZE) break;
      }
    }

    if (deleteEvents) {
      for (;;) {
        const removed = await deleteActivityEventBatch(principal.orgId, claimed.employee_id, tx);
        deletedEvents += removed;
        if (removed < DELETION_BATCH_SIZE) break;
      }
    }

    const finished = await finishDeletionRequest(
      principal.orgId,
      requestId,
      {
        status: 'completed',
        deletedEventCount: deleteEvents ? deletedEvents : null,
        deletedScreenshotCount: deleteScreenshots ? deletedScreenshots : null,
        error: null,
      },
      tx,
    );

    await recordAudit(
      ctx,
      principal,
      {
        action: AuditAction.DELETION_REQUEST_EXECUTE,
        subjectType: 'data_deletion_request',
        subjectId: requestId,
        subjectEmployeeId: claimed.employee_id,
        metadata: {
          scope: claimed.scope,
          deleted_event_count: deletedEvents,
          deleted_screenshot_count: deletedScreenshots,
        },
      },
      tx,
    );

    return { kind: 'completed' as const, request: finished };
  });

  if (outcome.kind === 'not_found') throw errors.notFound('Deletion request');
  if (outcome.kind === 'already_finished') {
    throw new AppError(
      ErrorCode.CONFLICT,
      `This deletion request has already been ${outcome.status}.`,
      { logContext: { requestId, status: outcome.status } },
    );
  }

  ctx.log.info('deletion request executed', { requestId });
  return ok({ deletion_request: outcome.request });
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const router = createDashboardRouter([
  { method: 'POST', path: '/employees', policy: POLICY.ownerWrite, handler: createEmployee },
  { method: 'PATCH', path: '/employees/{id}', policy: POLICY.ownerWrite, handler: patchEmployee },

  { method: 'GET', path: '/users', policy: POLICY.ownerWrite, handler: getUsers },
  { method: 'POST', path: '/users', policy: POLICY.ownerWrite, handler: createDashboardUser },
  { method: 'PATCH', path: '/users/{id}', policy: POLICY.ownerWrite, handler: patchDashboardUser },

  { method: 'GET', path: '/projects', policy: POLICY.ownerWrite, handler: getProjects },
  { method: 'POST', path: '/projects', policy: POLICY.ownerWrite, handler: createProjectRoute },
  { method: 'PATCH', path: '/projects/{id}', policy: POLICY.ownerWrite, handler: patchProject },
  { method: 'DELETE', path: '/projects/{id}', policy: POLICY.ownerWrite, handler: removeProject },
  {
    method: 'GET',
    path: '/projects/{id}/rules',
    policy: POLICY.ownerWrite,
    handler: getProjectRules,
  },
  {
    method: 'POST',
    path: '/projects/{id}/rules',
    policy: POLICY.ownerWrite,
    handler: createProjectRuleRoute,
  },
  {
    method: 'DELETE',
    path: '/projects/{id}/rules/{rid}',
    policy: POLICY.ownerWrite,
    handler: removeProjectRule,
  },

  { method: 'GET', path: '/config', policy: POLICY.ownerWrite, handler: getConfig },
  { method: 'PUT', path: '/config', policy: POLICY.ownerWrite, handler: putConfig },

  { method: 'GET', path: '/devices', policy: POLICY.ownerWrite, handler: getDevices },
  {
    method: 'POST',
    path: '/devices/enrollment-tokens',
    policy: POLICY.ownerWrite,
    handler: createEnrollmentToken,
  },
  {
    method: 'POST',
    path: '/devices/{id}/revoke',
    policy: POLICY.ownerWrite,
    handler: revokeDeviceRoute,
  },

  { method: 'GET', path: '/audit-log', policy: POLICY.ownerWrite, handler: getAuditLog },

  {
    method: 'GET',
    path: '/deletion-requests',
    policy: POLICY.ownerWrite,
    handler: getDeletionRequests,
  },
  {
    method: 'POST',
    path: '/deletion-requests',
    policy: POLICY.ownerWrite,
    handler: createDeletionRequest,
  },
  {
    method: 'POST',
    path: '/deletion-requests/{id}/execute',
    policy: POLICY.ownerWrite,
    handler: executeDeletionRequest,
  },
]);

export const handler = withHandler('admin-api', router);
