/**
 * Read queries for the dashboard.
 *
 * ## The rule this file exists to keep
 *
 * **Dashboard views read the aggregate tables, not `activity_events`.** `timesheets` and its four
 * child tables are the point of the nightly rollup: a day view is one indexed row per employee
 * instead of a scan over every sample the fleet produced. There are exactly two places below that
 * touch `activity_events`, and both are bounded by construction:
 *
 *  - `listRecentActivity` — the overview's "what is happening now" feed. Ordered by
 *    `(org_id, captured_at desc)`, which is precisely `activity_events_recent_idx`, and capped by
 *    a `LIMIT` the caller cannot raise past the schema's page ceiling.
 *  - `listEmployeeActivity` — the per-employee day drill-down that `GET /v1/employees/{id}/activity`
 *    serves. Anchored on `activity_events_employee_time_idx` by requiring both an employee and a
 *    single day, then keyset-paginated. Without the day bound it would be an unbounded scan of one
 *    person's whole history, which is the same mistake at 1/50th the scale.
 *
 * Anything else that wants raw events belongs in the aggregation job, not here.
 *
 * ## org_id, and where scoping comes from
 *
 * Every function takes `orgId` first and every statement filters on it. Two tables cannot be
 * filtered that way, because the schema gives them no `org_id`: `timesheet_*_totals` are keyed
 * only by `timesheet_id`. Their isolation is therefore *derived* — the ids handed to
 * `getTimesheetBreakdown` come from an org-scoped read of `timesheets` in the same request, and
 * that function is deliberately not exported in a form that accepts ids from anywhere else.
 *
 * ## Keyset pagination, not OFFSET
 *
 * `offset 5000` makes Postgres walk and discard 5 000 rows, so the last page of a long list is the
 * slowest, and a row inserted mid-scroll shifts every subsequent page. Every paginated read here
 * uses a tuple comparison on the same columns it orders by, so a page costs the same wherever it
 * falls and the cursor keeps its meaning while data arrives underneath it.
 */

import { errors } from '../shared/errors.js';

import type { Tx } from './executor.js';
import { run, runOne } from './executor.js';

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

/**
 * A keyset cursor: the sort key of the last row of the previous page.
 *
 * Opaque to the client on purpose. It is base64url of a two-field JSON object rather than, say,
 * the raw id — the ordering is `(timestamp, id)` and a client that learned to construct one from
 * an id alone would break the moment a second row shared that timestamp.
 */
export interface KeysetCursor {
  /** ISO-8601 instant of the last row on the previous page. */
  readonly t: string;
  /** Tie-breaking identifier of that row. */
  readonly i: string;
}

export function encodeCursor(instant: Date, id: string): string {
  const payload: KeysetCursor = { t: instant.toISOString(), i: id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes a cursor, rejecting anything this API did not issue.
 *
 * A corrupt cursor is a 400 rather than an ignored parameter: silently serving page one to a
 * caller who asked for page nine produces a list that appears to loop forever.
 */
export function decodeCursor(value: string): KeysetCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw errors.validation([{ field: 'cursor', message: 'is not a cursor issued by this API' }]);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as KeysetCursor).t !== 'string' ||
    typeof (parsed as KeysetCursor).i !== 'string' ||
    Number.isNaN(Date.parse((parsed as KeysetCursor).t))
  ) {
    throw errors.validation([{ field: 'cursor', message: 'is not a cursor issued by this API' }]);
  }

  return { t: (parsed as KeysetCursor).t, i: (parsed as KeysetCursor).i };
}

/** Splits a cursor into the two statement parameters every paginated query below takes. */
function cursorValues(cursor: string | undefined): [string | null, string | null] {
  if (cursor === undefined) return [null, null];
  const decoded = decodeCursor(cursor);
  return [decoded.t, decoded.i];
}

// ---------------------------------------------------------------------------
// Organisation and employee lookups
// ---------------------------------------------------------------------------

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  timezone: string;
}

export async function getOrganization(
  orgId: string,
  tx?: Tx,
): Promise<OrganizationRow | undefined> {
  return runOne<OrganizationRow>(
    {
      name: 'org-get',
      text: 'select id, name, slug, timezone from organizations where id = $1',
      values: [orgId],
    },
    tx,
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface DayTotalsRow {
  active_seconds: number;
  idle_seconds: number;
  total_seconds: number;
  screenshot_count: number;
  employees_with_activity: number;
}

/**
 * Organisation-wide totals for one work date.
 *
 * The sums are cast to `integer` rather than left as the `bigint` Postgres produces, because
 * `pg` returns `bigint` as a *string* to avoid precision loss — and a string silently
 * concatenating instead of adding is a bug that reaches the dashboard looking like data. The cast
 * is safe by construction: `timesheets_totals_chk` bounds a row at one day, so even a very large
 * organisation stays some five orders of magnitude below the 32-bit ceiling.
 */
export async function getDayTotals(
  orgId: string,
  workDate: string,
  tx?: Tx,
): Promise<DayTotalsRow> {
  const row = await runOne<DayTotalsRow>(
    {
      name: 'reporting-day-totals',
      text: `select coalesce(sum(active_seconds), 0)::integer   as active_seconds,
                    coalesce(sum(idle_seconds), 0)::integer     as idle_seconds,
                    coalesce(sum(total_seconds), 0)::integer    as total_seconds,
                    coalesce(sum(screenshot_count), 0)::integer as screenshot_count,
                    count(*) filter (where total_seconds > 0)::integer as employees_with_activity
               from timesheets
              where org_id = $1
                and work_date = $2::date`,
      values: [orgId, workDate],
    },
    tx,
  );

  // An aggregate with no GROUP BY always returns exactly one row, even over no data.
  if (row === undefined) throw new Error('reporting: day totals aggregate returned no row');
  return row;
}

export interface TrendRow {
  work_date: string;
  active_seconds: number;
  idle_seconds: number;
  employees_with_activity: number;
}

/**
 * Per-day totals across a range, for the overview's trend chart.
 *
 * `work_date` is rendered with `to_char` rather than returned as a `date`. `pg` parses a bare
 * `date` into a JS `Date` at *local* midnight, so a container running in UTC and a developer
 * machine in IST disagree about which day a row belongs to — the one class of timezone bug this
 * codebase is most careful about. A `YYYY-MM-DD` string has no such ambiguity.
 */
export async function getTrend(
  orgId: string,
  from: string,
  to: string,
  tx?: Tx,
): Promise<TrendRow[]> {
  const result = await run<TrendRow>(
    {
      name: 'reporting-trend',
      text: `select to_char(work_date, 'YYYY-MM-DD')             as work_date,
                    coalesce(sum(active_seconds), 0)::integer    as active_seconds,
                    coalesce(sum(idle_seconds), 0)::integer      as idle_seconds,
                    count(*) filter (where total_seconds > 0)::integer as employees_with_activity
               from timesheets
              where org_id = $1
                and work_date between $2::date and $3::date
              group by work_date
              order by work_date`,
      values: [orgId, from, to],
    },
    tx,
  );
  return result.rows;
}

export interface TeamDayRow {
  employee_id: string;
  full_name: string;
  email: string;
  timezone: string;
  status: string;
  active_seconds: number;
  idle_seconds: number;
  total_seconds: number;
  first_activity_at: Date | null;
  last_activity_at: Date | null;
  screenshot_count: number;
  last_seen_at: Date | null;
  device_count: number;
}

/**
 * One row per employee for a work date: the `/team` table, and the body of the overview.
 *
 * A `left join` from `employees`, not an inner one, so an employee with no timesheet for the day
 * appears with zeroes rather than vanishing. "Nobody recorded any time" and "that person is not
 * in the list" look identical to a reader otherwise, and only one of them is a reason to go and
 * check whether an agent has stopped reporting.
 */
export async function listTeamDay(
  orgId: string,
  workDate: string,
  includeInactive: boolean,
  tx?: Tx,
): Promise<TeamDayRow[]> {
  const result = await run<TeamDayRow>(
    {
      name: 'reporting-team-day',
      text: `select e.id                                       as employee_id,
                    e.full_name,
                    e.email::text                              as email,
                    e.timezone,
                    e.status,
                    coalesce(t.active_seconds, 0)              as active_seconds,
                    coalesce(t.idle_seconds, 0)                as idle_seconds,
                    coalesce(t.total_seconds, 0)               as total_seconds,
                    t.first_activity_at,
                    t.last_activity_at,
                    coalesce(t.screenshot_count, 0)            as screenshot_count,
                    d.last_seen_at,
                    coalesce(d.device_count, 0)                as device_count
               from employees e
               left join timesheets t
                      on t.org_id = e.org_id
                     and t.employee_id = e.id
                     and t.work_date = $2::date
               left join (
                      select employee_id,
                             max(last_seen_at)  as last_seen_at,
                             count(*)::integer  as device_count
                        from devices
                       where org_id = $1
                         and revoked_at is null
                       group by employee_id
                    ) d on d.employee_id = e.id
              where e.org_id = $1
                and (e.status = 'active' or $3::boolean)
              order by e.full_name, e.id`,
      values: [orgId, workDate, includeInactive],
    },
    tx,
  );
  return result.rows;
}

export interface ActiveDeviceRow {
  device_id: string;
  hostname: string;
  agent_version: string;
  employee_id: string;
  full_name: string;
  last_seen_at: Date;
}

/** Devices that have checked in recently — the overview's "who is working now". */
export async function listActiveDevices(
  orgId: string,
  withinSeconds: number,
  limit: number,
  tx?: Tx,
): Promise<ActiveDeviceRow[]> {
  const result = await run<ActiveDeviceRow>(
    {
      name: 'reporting-active-devices',
      text: `select d.id            as device_id,
                    d.hostname,
                    d.agent_version,
                    d.employee_id,
                    e.full_name,
                    d.last_seen_at
               from devices d
               join employees e on e.id = d.employee_id and e.org_id = d.org_id
              where d.org_id = $1
                and d.revoked_at is null
                and d.last_seen_at >= now() - make_interval(secs => $2::double precision)
              order by d.last_seen_at desc
              limit $3`,
      values: [orgId, withinSeconds, limit],
    },
    tx,
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Activity — the two bounded reads of activity_events
// ---------------------------------------------------------------------------

export interface RecentActivityRow {
  id: string;
  employee_id: string;
  full_name: string;
  event_type: string;
  captured_at: Date;
  duration_seconds: number;
  app_name: string | null;
  url_host: string | null;
  is_idle: boolean;
}

/**
 * The overview's recent-activity feed.
 *
 * Ordered on `(org_id, captured_at desc)` so the planner uses `activity_events_recent_idx`, and
 * capped by `limit`. Note what it does *not* select: `window_title` and `url_title` are absent.
 * A live feed of every window title in the organisation, on the first screen an admin sees, is
 * not a feature this product wants — the app name and the host say what someone is working in,
 * and the title, which can name a document, a client or a diagnosis, stays behind the deliberate
 * act of opening one employee's day.
 */
export async function listRecentActivity(
  orgId: string,
  limit: number,
  tx?: Tx,
): Promise<RecentActivityRow[]> {
  const result = await run<RecentActivityRow>(
    {
      name: 'reporting-recent-activity',
      text: `select a.id::text as id,
                    a.employee_id,
                    e.full_name,
                    a.event_type,
                    a.captured_at,
                    a.duration_seconds,
                    a.app_name,
                    a.url_host,
                    a.is_idle
               from activity_events a
               join employees e on e.id = a.employee_id and e.org_id = a.org_id
              where a.org_id = $1
              order by a.captured_at desc
              limit $2`,
      values: [orgId, limit],
    },
    tx,
  );
  return result.rows;
}

export interface EmployeeActivityRow {
  id: string;
  device_id: string;
  event_type: string;
  captured_at: Date;
  duration_seconds: number;
  app_name: string | null;
  app_exe: string | null;
  window_title: string | null;
  url_host: string | null;
  url_title: string | null;
  category: string | null;
  project_id: string | null;
  project_name: string | null;
  is_idle: boolean;
}

/**
 * One employee's raw activity for one day, keyset-paginated.
 *
 * Both bounds are load-bearing. The employee and the day together put this on
 * `activity_events_employee_time_idx` as a range scan, and the tuple comparison
 * `(captured_at, id) < (cursor)` continues that scan from where the previous page stopped rather
 * than re-walking it.
 */
export async function listEmployeeActivity(
  orgId: string,
  employeeId: string,
  dayStart: Date,
  dayEnd: Date,
  cursor: string | undefined,
  limit: number,
  tx?: Tx,
): Promise<EmployeeActivityRow[]> {
  const [cursorAt, cursorId] = cursorValues(cursor);

  const result = await run<EmployeeActivityRow>(
    {
      name: 'reporting-employee-activity',
      text: `select a.id::text as id,
                    a.device_id,
                    a.event_type,
                    a.captured_at,
                    a.duration_seconds,
                    a.app_name,
                    a.app_exe,
                    a.window_title,
                    a.url_host,
                    a.url_title,
                    a.category,
                    a.project_id,
                    p.name as project_name,
                    a.is_idle
               from activity_events a
               left join projects p on p.id = a.project_id and p.org_id = a.org_id
              where a.org_id = $1
                and a.employee_id = $2
                and a.captured_at >= $3
                and a.captured_at < $4
                and ($5::timestamptz is null
                     or (a.captured_at, a.id) < ($5::timestamptz, $6::bigint))
              order by a.captured_at desc, a.id desc
              limit $7`,
      values: [
        orgId,
        employeeId,
        dayStart.toISOString(),
        dayEnd.toISOString(),
        cursorAt,
        cursorId,
        limit,
      ],
    },
    tx,
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Timesheets
// ---------------------------------------------------------------------------

export interface TimesheetRow {
  id: string;
  employee_id: string;
  full_name: string;
  work_date: string;
  timezone: string;
  active_seconds: number;
  idle_seconds: number;
  total_seconds: number;
  first_activity_at: Date | null;
  last_activity_at: Date | null;
  screenshot_count: number;
  source_event_count: number;
  version: number;
  computed_at: Date;
}

/**
 * Timesheets across a date range, optionally for one employee.
 *
 * `employeeId` is `null` only for a caller the RBAC layer resolved to organisation-wide scope;
 * it is never derived from a path parameter here. See `resolveEmployeeScope`.
 */
export async function listTimesheets(
  orgId: string,
  from: string,
  to: string,
  employeeId: string | null,
  limit: number,
  tx?: Tx,
): Promise<TimesheetRow[]> {
  const result = await run<TimesheetRow>(
    {
      name: 'reporting-timesheets',
      text: `select t.id,
                    t.employee_id,
                    e.full_name,
                    to_char(t.work_date, 'YYYY-MM-DD') as work_date,
                    t.timezone,
                    t.active_seconds,
                    t.idle_seconds,
                    t.total_seconds,
                    t.first_activity_at,
                    t.last_activity_at,
                    t.screenshot_count,
                    t.source_event_count,
                    t.version,
                    t.computed_at
               from timesheets t
               join employees e on e.id = t.employee_id and e.org_id = t.org_id
              where t.org_id = $1
                and t.work_date between $2::date and $3::date
                and ($4::uuid is null or t.employee_id = $4::uuid)
              order by t.work_date desc, e.full_name, t.employee_id
              limit $5`,
      values: [orgId, from, to, employeeId, limit],
    },
    tx,
  );
  return result.rows;
}

export type BreakdownKind = 'app' | 'site' | 'category' | 'project';

export interface BreakdownRow {
  timesheet_id: string;
  kind: BreakdownKind;
  label: string;
  /** Present for `project` rows; null for the others. */
  project_id: string | null;
  seconds: number;
}

/**
 * The four child totals for a set of timesheets, in one statement.
 *
 * `timesheet_app_totals` and its siblings carry no `org_id` — the schema scopes them by
 * `timesheet_id` with `on delete cascade` and nothing else. So this function is only ever called
 * with ids that came out of `listTimesheets`, which *is* org-scoped, and the union below is the
 * whole reason those ids are not re-derived here: a second lookup by employee would be a second
 * place for the org filter to be forgotten.
 *
 * An empty id list short-circuits rather than issuing `= any('{}')`, which is a valid statement
 * that scans four tables to return nothing.
 */
export async function getTimesheetBreakdown(
  timesheetIds: readonly string[],
  tx?: Tx,
): Promise<BreakdownRow[]> {
  if (timesheetIds.length === 0) return [];

  const result = await run<BreakdownRow>(
    {
      name: 'reporting-timesheet-breakdown',
      text: `select 'app'::text as kind, timesheet_id, app_name as label,
                    null::uuid as project_id, seconds
               from timesheet_app_totals
              where timesheet_id = any($1::uuid[])
              union all
             select 'site'::text, timesheet_id, url_host, null::uuid, seconds
               from timesheet_site_totals
              where timesheet_id = any($1::uuid[])
              union all
             select 'category'::text, timesheet_id, category, null::uuid, seconds
               from timesheet_category_totals
              where timesheet_id = any($1::uuid[])
              union all
             select 'project'::text, tp.timesheet_id,
                    coalesce(p.name, 'Unknown project'), tp.project_id, tp.seconds
               from timesheet_project_totals tp
               left join projects p on p.id = tp.project_id
              where tp.timesheet_id = any($1::uuid[])
              order by seconds desc, label`,
      values: [timesheetIds],
    },
    tx,
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

export interface ScreenshotListRow {
  id: string;
  employee_id: string;
  device_id: string;
  captured_at: Date;
  width: number;
  height: number;
  byte_count: number;
  blurred: boolean;
  content_type: string;
}

/**
 * One employee's uploaded screenshots for a day.
 *
 * `upload_state = 'uploaded'` filters out both halves of an incomplete upload: a `pending` row is
 * a presign whose PUT never landed, and an `expired` one points at an object the retention
 * sweeper has already deleted. Listing either would produce a gallery of broken images and, worse,
 * an audit trail recording views of screenshots that do not exist.
 */
export async function listScreenshots(
  orgId: string,
  employeeId: string,
  dayStart: Date,
  dayEnd: Date,
  cursor: string | undefined,
  limit: number,
  tx?: Tx,
): Promise<ScreenshotListRow[]> {
  const [cursorAt, cursorId] = cursorValues(cursor);

  const result = await run<ScreenshotListRow>(
    {
      name: 'reporting-screenshot-list',
      text: `select id, employee_id, device_id, captured_at, width, height,
                    byte_count, blurred, content_type
               from screenshots
              where org_id = $1
                and employee_id = $2
                and captured_at >= $3
                and captured_at < $4
                and upload_state = 'uploaded'
                and ($5::timestamptz is null
                     or (captured_at, id) < ($5::timestamptz, $6::uuid))
              order by captured_at desc, id desc
              limit $7`,
      values: [
        orgId,
        employeeId,
        dayStart.toISOString(),
        dayEnd.toISOString(),
        cursorAt,
        cursorId,
        limit,
      ],
    },
    tx,
  );
  return result.rows;
}

export interface ViewableScreenshotRow {
  id: string;
  employee_id: string;
  device_id: string;
  captured_at: Date;
  s3_bucket: string;
  s3_key: string;
  content_type: string;
  byte_count: number;
  blurred: boolean;
  upload_state: 'pending' | 'uploaded' | 'expired';
}

/**
 * Looks a screenshot up for viewing, scoped to the organisation *and* the employee.
 *
 * The employee predicate is not redundant with the primary key. It is what makes the id in the
 * path unable to reach outside the scope the RBAC layer resolved: an employee who guesses another
 * person's screenshot id gets no row, and therefore no audit entry and no URL, rather than an
 * authorisation check somebody has to remember to write a second time.
 */
export async function findViewableScreenshot(
  orgId: string,
  employeeId: string,
  screenshotId: string,
  tx?: Tx,
): Promise<ViewableScreenshotRow | undefined> {
  return runOne<ViewableScreenshotRow>(
    {
      name: 'reporting-screenshot-find',
      text: `select id, employee_id, device_id, captured_at, s3_bucket, s3_key,
                    content_type, byte_count, blurred, upload_state
               from screenshots
              where org_id = $1
                and employee_id = $2
                and id = $3`,
      values: [orgId, employeeId, screenshotId],
    },
    tx,
  );
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export interface AuditLogRow {
  id: string;
  actor_user_id: string | null;
  actor_email: string;
  actor_role: string;
  action: string;
  subject_type: string;
  subject_id: string | null;
  subject_employee_id: string | null;
  subject_employee_name: string | null;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface AuditLogFilters {
  /** Inclusive lower bound, as an instant. */
  from?: Date | undefined;
  /** Exclusive upper bound. */
  to?: Date | undefined;
  action?: string | undefined;
  employeeId?: string | undefined;
  cursor?: string | undefined;
  limit: number;
}

/**
 * The audit trail, newest first.
 *
 * `host(ip)` renders the `inet` column as a plain address string; `pg` would otherwise hand back
 * the CIDR form, so a single address arrives as `203.0.113.10/32` and looks like a subnet in the
 * UI. Ordered on `(created_at desc, id desc)` to match `audit_log_org_time_idx`.
 */
export async function listAuditLog(
  orgId: string,
  filters: AuditLogFilters,
  tx?: Tx,
): Promise<AuditLogRow[]> {
  const [cursorAt, cursorId] = cursorValues(filters.cursor);

  const result = await run<AuditLogRow>(
    {
      name: 'reporting-audit-log',
      text: `select l.id::text as id,
                    l.actor_user_id,
                    l.actor_email,
                    l.actor_role,
                    l.action,
                    l.subject_type,
                    l.subject_id,
                    l.subject_employee_id,
                    e.full_name as subject_employee_name,
                    host(l.ip)  as ip,
                    l.user_agent,
                    l.metadata,
                    l.created_at
               from audit_log l
               left join employees e
                      on e.id = l.subject_employee_id
                     and e.org_id = l.org_id
              where l.org_id = $1
                and ($2::timestamptz is null or l.created_at >= $2::timestamptz)
                and ($3::timestamptz is null or l.created_at < $3::timestamptz)
                and ($4::text is null or l.action = $4::text)
                and ($5::uuid is null or l.subject_employee_id = $5::uuid)
                and ($6::timestamptz is null
                     or (l.created_at, l.id) < ($6::timestamptz, $7::bigint))
              order by l.created_at desc, l.id desc
              limit $8`,
      values: [
        orgId,
        filters.from?.toISOString() ?? null,
        filters.to?.toISOString() ?? null,
        filters.action ?? null,
        filters.employeeId ?? null,
        cursorAt,
        cursorId,
        filters.limit,
      ],
    },
    tx,
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface ExportRow {
  work_date: string;
  employee_id: string;
  full_name: string;
  email: string;
  external_ref: string | null;
  timezone: string;
  active_seconds: number;
  idle_seconds: number;
  total_seconds: number;
  first_activity_at: Date | null;
  last_activity_at: Date | null;
  screenshot_count: number;
  source_event_count: number;
}

/** How many rows one page of the export pulls. Bounds the memory the CSV encoder ever holds. */
export const EXPORT_PAGE_SIZE = 500;

async function exportPage(
  orgId: string,
  from: string,
  to: string,
  employeeId: string | null,
  afterDate: string | null,
  afterEmployeeId: string | null,
  tx?: Tx,
): Promise<ExportRow[]> {
  const result = await run<ExportRow>(
    {
      name: 'reporting-export-page',
      text: `select to_char(t.work_date, 'YYYY-MM-DD') as work_date,
                    t.employee_id,
                    e.full_name,
                    e.email::text as email,
                    e.external_ref,
                    t.timezone,
                    t.active_seconds,
                    t.idle_seconds,
                    t.total_seconds,
                    t.first_activity_at,
                    t.last_activity_at,
                    t.screenshot_count,
                    t.source_event_count
               from timesheets t
               join employees e on e.id = t.employee_id and e.org_id = t.org_id
              where t.org_id = $1
                and t.work_date between $2::date and $3::date
                and ($4::uuid is null or t.employee_id = $4::uuid)
                and ($5::date is null
                     or (t.work_date, t.employee_id) > ($5::date, $6::uuid))
              order by t.work_date, t.employee_id
              limit $7`,
      values: [orgId, from, to, employeeId, afterDate, afterEmployeeId, EXPORT_PAGE_SIZE],
    },
    tx,
  );
  return result.rows;
}

/**
 * Streams the export, one keyset page at a time.
 *
 * A generator rather than an array because a payroll export can span months: `select … order by`
 * with no limit would materialise every row in the Lambda's heap before the first byte of CSV
 * existed, and the memory needed would grow with the deployment's age. Pulling
 * `EXPORT_PAGE_SIZE` rows at a time keeps the ceiling constant and lets `src/export/csv.ts`
 * encode and release each page as it arrives.
 *
 * The keyset is `(work_date, employee_id)`, which is exactly the sort order and is unique by
 * `timesheets_employee_date_uq` — so no row can be visited twice or skipped, even if aggregation
 * writes a new timesheet while the export is running.
 */
export async function* iterateExportRows(
  orgId: string,
  from: string,
  to: string,
  employeeId: string | null,
  tx?: Tx,
): AsyncGenerator<ExportRow, void, undefined> {
  let afterDate: string | null = null;
  let afterEmployeeId: string | null = null;

  for (;;) {
    const page = await exportPage(orgId, from, to, employeeId, afterDate, afterEmployeeId, tx);
    if (page.length === 0) return;

    for (const row of page) yield row;

    if (page.length < EXPORT_PAGE_SIZE) return;

    const last = page[page.length - 1];
    if (last === undefined) return;
    afterDate = last.work_date;
    afterEmployeeId = last.employee_id;
  }
}
