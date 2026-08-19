/**
 * The administrative write side: employees, dashboard users, projects and their rules, the
 * monitoring configuration, device inventory and enrolment tokens, and data-deletion requests.
 *
 * Three conventions run through the whole file.
 *
 * **`org_id` first, and in every predicate.** Not for the plan — a uuid primary key needs no
 * help — but because it is the isolation guarantee. A handler holding an id from a path
 * parameter cannot reach across an organisation boundary, because the statement matches no rows.
 *
 * **A foreign key is not an org check.** `enrollment_tokens.employee_id` references
 * `employees (id)` with no org qualifier, so a token for an employee in *another* organisation
 * would satisfy the constraint perfectly. Every insert that names an employee therefore takes the
 * form `insert … select … from employees where id = $n and org_id = $1`: if the employee is not
 * this organisation's, the select produces nothing, the insert writes nothing, and the caller gets
 * a 404 instead of a cross-tenant row.
 *
 * **Patches use `coalesce` and `case`, never assembled SQL.** A dynamic `set` clause built from
 * whichever fields were present is how interpolation gets into a codebase that had banned it
 * everywhere else. `coalesce($n, column)` covers a non-nullable column; a nullable one needs a
 * separate "was this field supplied" boolean, because `null` is a value a caller may legitimately
 * want to store and `coalesce` cannot tell that apart from "leave it alone".
 */

import type { QueryResultRow } from 'pg';

import type { Tx } from './executor.js';
import { run, runOne } from './executor.js';

/**
 * A nullable column in a patch: absent leaves the column alone, `{ value: null }` clears it.
 *
 * The wrapper exists because `exactOptionalPropertyTypes` makes "absent" and "present and
 * undefined" different types, and this is the one place in the codebase where that distinction
 * carries meaning rather than being pedantry.
 */
export interface NullableSet<T> {
  value: T | null;
}

function setFlag<T>(field: NullableSet<T> | undefined): [boolean, T | null] {
  return field === undefined ? [false, null] : [true, field.value];
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

export interface EmployeeRow {
  id: string;
  full_name: string;
  email: string;
  external_ref: string | null;
  timezone: string;
  status: 'active' | 'inactive';
  hired_on: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Every statement below spells its column list out rather than sharing an interpolated constant.
 *
 * Not repetition for its own sake: no SQL string in this codebase is built by interpolation, so
 * "does any query interpolate?" is a question grep can answer with no false positives to triage.
 * A shared constant would be safe today and would make the next interpolation — the unsafe one —
 * indistinguishable from it.
 *
 * `hired_on` is rendered with `to_char` for the same reason `work_date` is in
 * `src/repositories/reporting.ts`: `pg` turns a bare `date` into a JS `Date` at local midnight, so
 * the value a UTC container reports and the value an IST developer sees differ by a day.
 */

export type EmployeeStatusFilter = 'active' | 'inactive' | 'all';

export async function listEmployees(
  orgId: string,
  status: EmployeeStatusFilter,
  tx?: Tx,
): Promise<EmployeeRow[]> {
  const result = await run<EmployeeRow>(
    {
      name: 'employees-list',
      text: `select id, full_name, email::text as email, external_ref, timezone, status,
                    to_char(hired_on, 'YYYY-MM-DD') as hired_on, created_at, updated_at
               from employees
              where org_id = $1
                and ($2::text = 'all' or status = $2::text)
              order by full_name, id`,
      values: [orgId, status],
    },
    tx,
  );
  return result.rows;
}

export async function getEmployee(
  orgId: string,
  employeeId: string,
  tx?: Tx,
): Promise<EmployeeRow | undefined> {
  return runOne<EmployeeRow>(
    {
      name: 'employees-get',
      text: `select id, full_name, email::text as email, external_ref, timezone, status,
                    to_char(hired_on, 'YYYY-MM-DD') as hired_on, created_at, updated_at
               from employees
              where org_id = $1 and id = $2`,
      values: [orgId, employeeId],
    },
    tx,
  );
}

export interface NewEmployee {
  fullName: string;
  email: string;
  externalRef: string | null;
  /** Resolved by the handler, defaulting to the organisation's zone. */
  timezone: string;
  status: 'active' | 'inactive';
  hiredOn: string | null;
}

export async function insertEmployee(
  orgId: string,
  input: NewEmployee,
  tx?: Tx,
): Promise<EmployeeRow> {
  const row = await runOne<EmployeeRow>(
    {
      name: 'employees-insert',
      text: `insert into employees (org_id, full_name, email, external_ref, timezone, status, hired_on)
                  values ($1, $2, $3::citext, $4, $5, $6, $7::date)
             returning id, full_name, email::text as email, external_ref, timezone, status,
                       to_char(hired_on, 'YYYY-MM-DD') as hired_on, created_at, updated_at`,
      values: [
        orgId,
        input.fullName,
        input.email,
        input.externalRef,
        input.timezone,
        input.status,
        input.hiredOn,
      ],
    },
    tx,
  );

  // An INSERT … RETURNING either returns its row or throws; a conflict raises rather than
  // returning nothing. If this ever fires the assumption is wrong, and half an employee is worse
  // than a failure.
  if (row === undefined) throw new Error('employees insert returned no row');
  return row;
}

export interface EmployeePatch {
  fullName?: string | undefined;
  email?: string | undefined;
  timezone?: string | undefined;
  status?: 'active' | 'inactive' | undefined;
  externalRef?: NullableSet<string> | undefined;
  hiredOn?: NullableSet<string> | undefined;
}

export async function updateEmployee(
  orgId: string,
  employeeId: string,
  patch: EmployeePatch,
  tx?: Tx,
): Promise<EmployeeRow | undefined> {
  const [externalRefSet, externalRef] = setFlag(patch.externalRef);
  const [hiredOnSet, hiredOn] = setFlag(patch.hiredOn);

  return runOne<EmployeeRow>(
    {
      name: 'employees-update',
      text: `update employees
                set full_name    = coalesce($3::text, full_name),
                    email        = coalesce($4::citext, email),
                    timezone     = coalesce($5::text, timezone),
                    status       = coalesce($6::text, status),
                    external_ref = case when $7::boolean then $8::text else external_ref end,
                    hired_on     = case when $9::boolean then $10::date else hired_on end
              where org_id = $1
                and id = $2
          returning id, full_name, email::text as email, external_ref, timezone, status,
                    to_char(hired_on, 'YYYY-MM-DD') as hired_on, created_at, updated_at`,
      values: [
        orgId,
        employeeId,
        patch.fullName ?? null,
        patch.email ?? null,
        patch.timezone ?? null,
        patch.status ?? null,
        externalRefSet,
        externalRef,
        hiredOnSet,
        hiredOn,
      ],
    },
    tx,
  );
}

// ---------------------------------------------------------------------------
// Dashboard users
// ---------------------------------------------------------------------------

export interface UserRow {
  id: string;
  cognito_sub: string;
  email: string;
  role: 'owner' | 'manager' | 'employee';
  employee_id: string | null;
  employee_name: string | null;
  status: 'active' | 'disabled';
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function listUsers(orgId: string, tx?: Tx): Promise<UserRow[]> {
  const result = await run<UserRow>(
    {
      name: 'users-list',
      text: `select u.id, u.cognito_sub, u.email::text as email, u.role, u.employee_id,
                    e.full_name as employee_name, u.status, u.last_login_at,
                    u.created_at, u.updated_at
               from users u
               left join employees e on e.id = u.employee_id and e.org_id = u.org_id
              where u.org_id = $1
              order by u.role, u.email`,
      values: [orgId],
    },
    tx,
  );
  return result.rows;
}

export async function getUser(
  orgId: string,
  userId: string,
  tx?: Tx,
): Promise<UserRow | undefined> {
  return runOne<UserRow>(
    {
      name: 'users-get',
      text: `select u.id, u.cognito_sub, u.email::text as email, u.role, u.employee_id,
                    e.full_name as employee_name, u.status, u.last_login_at,
                    u.created_at, u.updated_at
               from users u
               left join employees e on e.id = u.employee_id and e.org_id = u.org_id
              where u.org_id = $1 and u.id = $2`,
      values: [orgId, userId],
    },
    tx,
  );
}

export interface NewUser {
  cognitoSub: string;
  email: string;
  role: 'owner' | 'manager' | 'employee';
  employeeId: string | null;
  status: 'active' | 'disabled';
}

/**
 * Creates the `users` row.
 *
 * Returns `undefined` when `employeeId` was supplied but names an employee outside this
 * organisation — the `exists` guard is what enforces that, since the foreign key references
 * `employees (id)` with no org qualifier and would accept another tenant's employee quite
 * happily. A null `employeeId` is permitted and produces an admin-only account.
 */
export async function insertUser(
  orgId: string,
  input: NewUser,
  tx?: Tx,
): Promise<UserRow | undefined> {
  const inserted = await runOne<{ id: string }>(
    {
      name: 'users-insert',
      text: `insert into users (org_id, cognito_sub, email, role, employee_id, status)
             select $1, $2, $3::citext, $4, $5::uuid, $6
              where $5::uuid is null
                 or exists (select 1 from employees e
                             where e.id = $5::uuid and e.org_id = $1)
          returning id`,
      values: [orgId, input.cognitoSub, input.email, input.role, input.employeeId, input.status],
    },
    tx,
  );

  if (inserted === undefined) return undefined;
  return getUser(orgId, inserted.id, tx);
}

export interface UserPatch {
  role?: 'owner' | 'manager' | 'employee' | undefined;
  status?: 'active' | 'disabled' | undefined;
  employeeId?: NullableSet<string> | undefined;
}

/**
 * Updates a user.
 *
 * The employee link is validated the same way as on insert: `$6::uuid` must name an employee in
 * this organisation, or the whole statement matches nothing. `users_employee_role_chk` then
 * catches the remaining incoherent combination — clearing the employee link on an `employee`-role
 * account — as a check violation, which the handler reports as a 409 rather than swallowing.
 */
export async function updateUser(
  orgId: string,
  userId: string,
  patch: UserPatch,
  tx?: Tx,
): Promise<UserRow | undefined> {
  const [employeeSet, employeeId] = setFlag(patch.employeeId);

  const updated = await runOne<{ id: string }>(
    {
      name: 'users-update',
      text: `update users u
                set role        = coalesce($3::text, u.role),
                    status      = coalesce($4::text, u.status),
                    employee_id = case when $5::boolean then $6::uuid else u.employee_id end
              where u.org_id = $1
                and u.id = $2
                and (
                      not $5::boolean
                   or $6::uuid is null
                   or exists (select 1 from employees e
                               where e.id = $6::uuid and e.org_id = $1)
                    )
          returning u.id`,
      values: [orgId, userId, patch.role ?? null, patch.status ?? null, employeeSet, employeeId],
    },
    tx,
  );

  if (updated === undefined) return undefined;
  return getUser(orgId, userId, tx);
}

// ---------------------------------------------------------------------------
// Projects and rules
// ---------------------------------------------------------------------------

export interface ProjectRow {
  id: string;
  name: string;
  code: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export async function listProjects(
  orgId: string,
  includeInactive: boolean,
  tx?: Tx,
): Promise<ProjectRow[]> {
  const result = await run<ProjectRow>(
    {
      name: 'projects-list',
      text: `select id, name, code, is_active, created_at, updated_at
               from projects
              where org_id = $1
                and (is_active or $2::boolean)
              order by name`,
      values: [orgId, includeInactive],
    },
    tx,
  );
  return result.rows;
}

export async function getProject(
  orgId: string,
  projectId: string,
  tx?: Tx,
): Promise<ProjectRow | undefined> {
  return runOne<ProjectRow>(
    {
      name: 'projects-get',
      text: `select id, name, code, is_active, created_at, updated_at
               from projects where org_id = $1 and id = $2`,
      values: [orgId, projectId],
    },
    tx,
  );
}

export async function insertProject(
  orgId: string,
  input: { name: string; code: string | null; isActive: boolean },
  tx?: Tx,
): Promise<ProjectRow> {
  const row = await runOne<ProjectRow>(
    {
      name: 'projects-insert',
      text: `insert into projects (org_id, name, code, is_active)
                  values ($1, $2, $3, $4)
             returning id, name, code, is_active, created_at, updated_at`,
      values: [orgId, input.name, input.code, input.isActive],
    },
    tx,
  );
  if (row === undefined) throw new Error('projects insert returned no row');
  return row;
}

export interface ProjectPatch {
  name?: string | undefined;
  isActive?: boolean | undefined;
  code?: NullableSet<string> | undefined;
}

export async function updateProject(
  orgId: string,
  projectId: string,
  patch: ProjectPatch,
  tx?: Tx,
): Promise<ProjectRow | undefined> {
  const [codeSet, code] = setFlag(patch.code);

  return runOne<ProjectRow>(
    {
      name: 'projects-update',
      text: `update projects
                set name      = coalesce($3::text, name),
                    is_active = coalesce($4::boolean, is_active),
                    code      = case when $5::boolean then $6::text else code end
              where org_id = $1
                and id = $2
          returning id, name, code, is_active, created_at, updated_at`,
      values: [orgId, projectId, patch.name ?? null, patch.isActive ?? null, codeSet, code],
    },
    tx,
  );
}

/**
 * `DELETE /v1/projects/{id}` retires a project; it does not remove it.
 *
 * This is a schema-driven decision, not a shortcut. `timesheet_project_totals` cascades from
 * `projects`, so a real `DELETE` would silently rewrite history: every past timesheet's
 * per-project breakdown for that project would disappear, and a payroll export run last month
 * would no longer reproduce. `activity_events.project_id` is `on delete set null`, so the raw
 * attribution would go too.
 *
 * `is_active` exists precisely so a project can stop being offered without any of that happening.
 * The route therefore flips it, the audit entry says `project.deactivate`, and the response makes
 * plain what occurred rather than reporting a deletion that did not.
 */
export async function deactivateProject(
  orgId: string,
  projectId: string,
  tx?: Tx,
): Promise<ProjectRow | undefined> {
  return runOne<ProjectRow>(
    {
      name: 'projects-deactivate',
      text: `update projects
                set is_active = false
              where org_id = $1
                and id = $2
          returning id, name, code, is_active, created_at, updated_at`,
      values: [orgId, projectId],
    },
    tx,
  );
}

export interface ProjectRuleRow {
  id: string;
  project_id: string;
  match_type: 'app_exe' | 'url_host' | 'title_contains' | 'title_regex';
  pattern: string;
  priority: number;
  created_at: Date;
}

export async function listProjectRules(
  orgId: string,
  projectId: string,
  tx?: Tx,
): Promise<ProjectRuleRow[]> {
  const result = await run<ProjectRuleRow>(
    {
      name: 'project-rules-list',
      text: `select id, project_id, match_type, pattern, priority, created_at
               from project_rules
              where org_id = $1 and project_id = $2
              order by priority, created_at, id`,
      values: [orgId, projectId],
    },
    tx,
  );
  return result.rows;
}

/**
 * Adds a rule.
 *
 * `insert … select … from projects where org_id = $1` is the org check: `project_rules` has both
 * an `org_id` and a `project_id`, and nothing in the schema stops the two disagreeing. Deriving
 * the `project_id` from an org-scoped select makes that state unreachable through this API.
 */
export async function insertProjectRule(
  orgId: string,
  projectId: string,
  input: { matchType: string; pattern: string; priority: number },
  tx?: Tx,
): Promise<ProjectRuleRow | undefined> {
  return runOne<ProjectRuleRow>(
    {
      name: 'project-rules-insert',
      text: `insert into project_rules (org_id, project_id, match_type, pattern, priority)
             select $1, p.id, $3, $4, $5
               from projects p
              where p.org_id = $1 and p.id = $2
          returning id, project_id, match_type, pattern, priority, created_at`,
      values: [orgId, projectId, input.matchType, input.pattern, input.priority],
    },
    tx,
  );
}

/**
 * Removes a rule. A genuine delete, unlike the project itself: a rule is configuration that
 * describes how *future* aggregation attributes activity, and nothing historical hangs off it —
 * `timesheet_project_totals` references the project, not the rule that matched.
 */
export async function deleteProjectRule(
  orgId: string,
  projectId: string,
  ruleId: string,
  tx?: Tx,
): Promise<ProjectRuleRow | undefined> {
  return runOne<ProjectRuleRow>(
    {
      name: 'project-rules-delete',
      text: `delete from project_rules
              where org_id = $1 and project_id = $2 and id = $3
          returning id, project_id, match_type, pattern, priority, created_at`,
      values: [orgId, projectId, ruleId],
    },
    tx,
  );
}

// ---------------------------------------------------------------------------
// Monitoring configuration
// ---------------------------------------------------------------------------

export interface MonitoringConfigUpdate {
  sampleIntervalSeconds: number;
  idleThresholdSeconds: number;
  captureWindowTitles: boolean;
  captureUrls: boolean;
  screenshotEnabled: boolean;
  screenshotIntervalSeconds: number;
  screenshotBlur: boolean;
  workHoursOnly: boolean;
  workHoursStart: string;
  workHoursEnd: string;
  workDays: readonly number[];
  excludedApps: readonly string[];
  excludedUrlPatterns: readonly string[];
  retentionDaysEvents: number;
  retentionDaysScreenshots: number;
}

/**
 * Replaces the organisation's monitoring configuration and bumps `config_version`.
 *
 * The bump is part of the same statement, not a separate write, because the version is how a
 * change actually reaches a laptop: the agent polls `GET /v1/device/config`, compares versions and
 * reloads. A configuration saved without a bumped version is a setting the fleet never applies —
 * and the setting most likely to be changed in a hurry is one that turns capture *off*.
 *
 * `updated_at` is assigned explicitly because, unlike `employees` or `projects`, this table has no
 * `wl_touch_updated_at` trigger in `0001_init.sql`.
 */
export async function updateMonitoringConfig(
  orgId: string,
  input: MonitoringConfigUpdate,
  updatedByUserId: string,
  tx?: Tx,
): Promise<{ config_version: number } | undefined> {
  return runOne<{ config_version: number }>(
    {
      name: 'monitoring-config-update',
      text: `update monitoring_config
                set config_version              = config_version + 1,
                    sample_interval_seconds     = $2,
                    idle_threshold_seconds      = $3,
                    capture_window_titles       = $4,
                    capture_urls                = $5,
                    screenshot_enabled          = $6,
                    screenshot_interval_seconds = $7,
                    screenshot_blur             = $8,
                    work_hours_only             = $9,
                    work_hours_start            = $10::time,
                    work_hours_end              = $11::time,
                    work_days                   = $12::smallint[],
                    excluded_apps               = $13::text[],
                    excluded_url_patterns       = $14::text[],
                    retention_days_events       = $15,
                    retention_days_screenshots  = $16,
                    updated_by_user_id          = $17,
                    updated_at                  = now()
              where org_id = $1
          returning config_version`,
      values: [
        orgId,
        input.sampleIntervalSeconds,
        input.idleThresholdSeconds,
        input.captureWindowTitles,
        input.captureUrls,
        input.screenshotEnabled,
        input.screenshotIntervalSeconds,
        input.screenshotBlur,
        input.workHoursOnly,
        input.workHoursStart,
        input.workHoursEnd,
        input.workDays,
        input.excludedApps,
        input.excludedUrlPatterns,
        input.retentionDaysEvents,
        input.retentionDaysScreenshots,
        updatedByUserId,
      ],
    },
    tx,
  );
}

// ---------------------------------------------------------------------------
// Device inventory and enrolment tokens
// ---------------------------------------------------------------------------

export interface DeviceInventoryRow {
  id: string;
  employee_id: string;
  full_name: string;
  hostname: string;
  os: string;
  os_version: string;
  agent_version: string;
  key_version: number;
  enrolled_at: Date;
  last_seen_at: Date | null;
  last_config_fetch_at: Date | null;
  notice_acknowledged_at: Date | null;
  revoked_at: Date | null;
}

export async function listDevices(
  orgId: string,
  limit: number,
  tx?: Tx,
): Promise<DeviceInventoryRow[]> {
  const result = await run<DeviceInventoryRow>(
    {
      name: 'devices-list',
      text: `select d.id, d.employee_id, e.full_name, d.hostname, d.os, d.os_version,
                    d.agent_version, d.key_version, d.enrolled_at, d.last_seen_at,
                    d.last_config_fetch_at, d.notice_acknowledged_at, d.revoked_at
               from devices d
               join employees e on e.id = d.employee_id and e.org_id = d.org_id
              where d.org_id = $1
              order by (d.revoked_at is not null), d.last_seen_at desc nulls last, d.hostname
              limit $2`,
      values: [orgId, limit],
    },
    tx,
  );
  return result.rows;
}

export interface EnrollmentTokenCreated {
  id: string;
  employee_id: string;
  expires_at: Date;
  created_at: Date;
}

/**
 * Records a new enrolment token.
 *
 * Only `sha256(token)` reaches the database — the token itself is returned to the caller once and
 * is not recoverable afterwards, which is what makes the row safe to keep and the credential safe
 * to lose. Expiry is computed by the database's clock, not the Lambda's: there should be exactly
 * one clock deciding whether a credential is still valid.
 */
export async function insertEnrollmentToken(
  orgId: string,
  employeeId: string,
  tokenHash: Buffer,
  expiresInHours: number,
  createdByUserId: string,
  tx?: Tx,
): Promise<EnrollmentTokenCreated | undefined> {
  return runOne<EnrollmentTokenCreated>(
    {
      name: 'enrollment-token-insert',
      text: `insert into enrollment_tokens (org_id, employee_id, token_hash, expires_at,
                                            created_by_user_id)
             select $1, e.id, $3,
                    now() + make_interval(hours => $4::double precision), $5
               from employees e
              where e.org_id = $1
                and e.id = $2
                and e.status = 'active'
          returning id, employee_id, expires_at, created_at`,
      values: [orgId, employeeId, tokenHash, expiresInHours, createdByUserId],
    },
    tx,
  );
}

// ---------------------------------------------------------------------------
// Data deletion requests
// ---------------------------------------------------------------------------

export type DeletionScope = 'all' | 'screenshots' | 'events';

export interface DeletionRequestRow {
  id: string;
  employee_id: string;
  full_name: string | null;
  scope: DeletionScope;
  requested_by_user_id: string | null;
  reason: string | null;
  requested_at: Date;
  status: 'pending' | 'completed' | 'failed';
  completed_at: Date | null;
  deleted_event_count: number | null;
  deleted_screenshot_count: number | null;
  error: string | null;
}

export async function listDeletionRequests(
  orgId: string,
  limit: number,
  tx?: Tx,
): Promise<DeletionRequestRow[]> {
  const result = await run<DeletionRequestRow>(
    {
      name: 'deletion-requests-list',
      text: `select r.id, r.employee_id, e.full_name, r.scope,
                    r.requested_by_user_id, r.reason, r.requested_at, r.status,
                    r.completed_at, r.deleted_event_count,
                    r.deleted_screenshot_count, r.error
               from data_deletion_requests r
               left join employees e on e.id = r.employee_id and e.org_id = r.org_id
              where r.org_id = $1
              order by r.requested_at desc
              limit $2`,
      values: [orgId, limit],
    },
    tx,
  );
  return result.rows;
}

export async function insertDeletionRequest(
  orgId: string,
  input: {
    employeeId: string;
    scope: DeletionScope;
    requestedByUserId: string;
    reason: string | null;
  },
  tx?: Tx,
): Promise<DeletionRequestRow | undefined> {
  const inserted = await runOne<{ id: string }>(
    {
      name: 'deletion-requests-insert',
      text: `insert into data_deletion_requests (org_id, employee_id, scope,
                                                 requested_by_user_id, reason)
             select $1, e.id, $3, $4, $5
               from employees e
              where e.org_id = $1 and e.id = $2
          returning id`,
      values: [orgId, input.employeeId, input.scope, input.requestedByUserId, input.reason],
    },
    tx,
  );

  if (inserted === undefined) return undefined;
  return runOne<DeletionRequestRow>(
    {
      name: 'deletion-requests-get',
      text: `select r.id, r.employee_id, e.full_name, r.scope,
                    r.requested_by_user_id, r.reason, r.requested_at, r.status,
                    r.completed_at, r.deleted_event_count,
                    r.deleted_screenshot_count, r.error
               from data_deletion_requests r
               left join employees e on e.id = r.employee_id and e.org_id = r.org_id
              where r.org_id = $1 and r.id = $2`,
      values: [orgId, inserted.id],
    },
    tx,
  );
}

export interface ClaimedDeletionRequest {
  id: string;
  employee_id: string;
  scope: DeletionScope;
  status: 'pending' | 'completed' | 'failed';
}

/**
 * Takes the row lock for an execution.
 *
 * `for update` rather than a status flip, because the schema's `status` domain is
 * `pending | completed | failed` with `deletion_completed_chk` tying `completed_at` to it — there
 * is no "in progress" value to write, and inventing one would need a migration. The row lock does
 * the same job for the duration of the transaction: a second `execute` arriving concurrently
 * blocks, then reads `completed` and refuses.
 */
export async function claimDeletionRequest(
  orgId: string,
  requestId: string,
  tx: Tx,
): Promise<ClaimedDeletionRequest | undefined> {
  return runOne<ClaimedDeletionRequest>(
    {
      name: 'deletion-requests-claim',
      text: `select id, employee_id, scope, status
               from data_deletion_requests
              where org_id = $1 and id = $2
                for update`,
      values: [orgId, requestId],
    },
    tx,
  );
}

/** How many rows one erasure statement touches. Bounds lock duration and statement time. */
export const DELETION_BATCH_SIZE = 2000;

/**
 * Deletes one batch of an employee's activity events, returning how many went.
 *
 * Batched rather than a single `delete … where employee_id = $2`, because the pool sets
 * `statement_timeout` to 20 seconds and 90 days of samples for one person can exceed that — and a
 * timed-out erasure that rolled back is the one outcome an erasure must not have. The caller loops
 * until a batch comes back short.
 */
export async function deleteActivityEventBatch(
  orgId: string,
  employeeId: string,
  tx: Tx,
): Promise<number> {
  const result = await run<QueryResultRow>(
    {
      name: 'deletion-events-batch',
      text: `delete from activity_events
              where id in (
                    select id from activity_events
                     where org_id = $1 and employee_id = $2
                     limit $3
                  )`,
      values: [orgId, employeeId, DELETION_BATCH_SIZE],
    },
    tx,
  );
  return result.rowCount ?? 0;
}

export interface ScreenshotObjectRow {
  id: string;
  s3_bucket: string;
  s3_key: string;
}

/** One batch of an employee's screenshot rows, with the object each points at. */
export async function selectScreenshotBatch(
  orgId: string,
  employeeId: string,
  tx: Tx,
): Promise<ScreenshotObjectRow[]> {
  const result = await run<ScreenshotObjectRow>(
    {
      name: 'deletion-screenshots-select',
      text: `select id, s3_bucket, s3_key
               from screenshots
              where org_id = $1 and employee_id = $2
              order by captured_at
              limit $3`,
      values: [orgId, employeeId, DELETION_BATCH_SIZE],
    },
    tx,
  );
  return result.rows;
}

export async function deleteScreenshotRows(
  orgId: string,
  ids: readonly string[],
  tx: Tx,
): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await run<QueryResultRow>(
    {
      name: 'deletion-screenshots-delete',
      text: 'delete from screenshots where org_id = $1 and id = any($2::uuid[])',
      values: [orgId, ids],
    },
    tx,
  );
  return result.rowCount ?? 0;
}

/**
 * Records the outcome.
 *
 * `completed_at` moves with `status` because `deletion_completed_chk` requires it: the constraint
 * reads `(status = 'pending') = (completed_at is null)`, so a `failed` row needs a timestamp too.
 * That is the right shape — a failed erasure is a finished attempt, and when it finished is
 * exactly what someone reconstructing the incident will want.
 */
export async function finishDeletionRequest(
  orgId: string,
  requestId: string,
  outcome: {
    status: 'completed' | 'failed';
    deletedEventCount: number | null;
    deletedScreenshotCount: number | null;
    error: string | null;
  },
  tx: Tx,
): Promise<DeletionRequestRow | undefined> {
  await run<QueryResultRow>(
    {
      name: 'deletion-requests-finish',
      text: `update data_deletion_requests
                set status                   = $3,
                    completed_at             = now(),
                    deleted_event_count      = $4,
                    deleted_screenshot_count = $5,
                    error                    = $6
              where org_id = $1 and id = $2`,
      values: [
        orgId,
        requestId,
        outcome.status,
        outcome.deletedEventCount,
        outcome.deletedScreenshotCount,
        outcome.error,
      ],
    },
    tx,
  );

  return runOne<DeletionRequestRow>(
    {
      name: 'deletion-requests-get',
      text: `select r.id, r.employee_id, e.full_name, r.scope,
                    r.requested_by_user_id, r.reason, r.requested_at, r.status,
                    r.completed_at, r.deleted_event_count,
                    r.deleted_screenshot_count, r.error
               from data_deletion_requests r
               left join employees e on e.id = r.employee_id and e.org_id = r.org_id
              where r.org_id = $1 and r.id = $2`,
      values: [orgId, requestId],
    },
    tx,
  );
}
