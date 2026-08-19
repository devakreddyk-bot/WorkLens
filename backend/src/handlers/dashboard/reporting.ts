/**
 * `reporting-api` — every dashboard read.
 *
 * One Lambda serving nine routes, dispatched on method and path by
 * `createDashboardRouter`. One function rather than nine because they share a connection pool
 * against a `db.t4g.micro` (`DB_POOL_MAX = 1` per container, see `src/shared/db.ts`): nine
 * separately-scaling functions would each hold their own warm connections for the same traffic,
 * and the pool ceiling — not CPU — is what this database runs out of first.
 *
 * ## What every route here has in common
 *
 *  - `org_id` comes from the verified token. There is no route on which a caller can name one.
 *  - The subject employee comes from `resolveEmployeeScope`, which rewrites it for an `employee`
 *    caller and refuses a request for anybody else. The path parameter is an *input* to that
 *    decision, never the decision itself.
 *  - Day boundaries are computed in the *employee's* timezone, not the server's and not the
 *    organisation's. A distributed team's "Tuesday" differs per person, which is why
 *    `employees.timezone` exists (docs/PLAN.md §3).
 *  - The two routes that expose screenshots write their `audit_log` row **before** producing
 *    anything. See `issueScreenshotUrl`.
 */

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { localDateOf, startOfLocalDay, startOfNextLocalDay } from '../../aggregation/zone.js';
import type { Principal, RouteParams } from '../../middleware/cognitoAuth.js';
import {
  POLICY,
  assertAdminMfaForSubject,
  createDashboardRouter,
  requireEmployeeScope,
  resolveEmployeeScope,
} from '../../middleware/cognitoAuth.js';
import { AuditAction, recordAudit } from '../../middleware/audit.js';
import { getEmployee, listEmployees } from '../../repositories/employees.js';
import type { BreakdownRow, ExportRow, TimesheetRow } from '../../repositories/reporting.js';
import {
  encodeCursor,
  findViewableScreenshot,
  getDayTotals,
  getOrganization,
  getTimesheetBreakdown,
  getTrend,
  iterateExportRows,
  listActiveDevices,
  listEmployeeActivity,
  listRecentActivity,
  listScreenshots,
  listTeamDay,
  listTimesheets,
} from '../../repositories/reporting.js';
import { collectCsv, encodeCsv } from '../../export/csv.js';
import {
  activityQuery,
  employeeListQuery,
  employeeTimesheetQuery,
  exportQuery,
  overviewQuery,
  parseQuery,
  screenshotListQuery,
  timesheetRangeQuery,
} from '../../schemas/dashboard.js';
import { config } from '../../shared/config.js';
import { errors } from '../../shared/errors.js';
import type { JsonResponse, RequestContext } from '../../shared/http.js';
import { ok, withHandler } from '../../shared/http.js';

/**
 * Module scope, so a warm container reuses the client and its resolved credentials. Reached
 * through the VPC's free S3 gateway endpoint, so no route to the internet is needed.
 */
const s3 = new S3Client({ region: config.AWS_REGION });

/** How recently a device must have checked in to count as "working now" on the overview. */
const ACTIVE_WITHIN_SECONDS = 600;

/** Ceiling on the overview's live feed and its active-device list. Both are glances, not reports. */
const OVERVIEW_FEED_LIMIT = 25;
const OVERVIEW_TREND_DAYS = 7;

/**
 * Largest CSV the export route will return.
 *
 * A Lambda proxy response is capped at 6 MB, and the CSV travels base64-encoded inside a JSON
 * envelope (see `exportTimesheets`), which costs a third on top. 4 MB of CSV is about 5.4 MB
 * encoded, leaving room for the envelope — and 4 MB is roughly 40 000 timesheet rows, or two years
 * of a fifty-person organisation.
 */
const MAX_EXPORT_CSV_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Loads the employee a route is about, in the caller's permitted scope.
 *
 * Does two jobs that must not be separated. It resolves the RBAC scope — so an `employee` asking
 * about somebody else is refused here rather than three lines later — and it returns the row,
 * whose `timezone` is what every day boundary below is computed in. A route that skipped this and
 * used the path parameter directly would be the one bug this design is built to prevent.
 */
async function loadSubject(
  principal: Principal,
  params: RouteParams,
): Promise<{ employeeId: string; timezone: string; fullName: string }> {
  const employeeId = requireEmployeeScope(principal, params.id);

  // Re-checks D7 now that the subject is known: `POLICY.employeeRead` cannot be `adminScoped`,
  // because an employee's own self-view must not be MFA-gated, so an admin reading somebody
  // else's data through these routes is gated here instead.
  assertAdminMfaForSubject(principal, employeeId);

  const employee = await getEmployee(principal.orgId, employeeId);
  if (employee === undefined) throw errors.notFound('Employee');

  return { employeeId, timezone: employee.timezone, fullName: employee.full_name };
}

/** The half-open instant range covering one calendar day in `timezone`. */
function dayBounds(date: string, timezone: string): { start: Date; end: Date } {
  return { start: startOfLocalDay(date, timezone), end: startOfNextLocalDay(date, timezone) };
}

/**
 * The cursor for the next page, or null when this page is the last.
 *
 * `rows.length === limit` is treated as "there may be more", which can produce one empty final
 * page. That is the right trade: the alternative is fetching `limit + 1` rows on every request to
 * answer a question the caller usually does not ask.
 */
function nextCursor<T>(
  rows: readonly T[],
  limit: number,
  keyOf: (row: T) => { at: Date; id: string },
): string | null {
  if (rows.length < limit) return null;
  const last = rows[rows.length - 1];
  if (last === undefined) return null;
  const key = keyOf(last);
  return encodeCursor(key.at, key.id);
}

function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

// ---------------------------------------------------------------------------
// GET /v1/me
// ---------------------------------------------------------------------------

/**
 * The caller's own identity and entitlements.
 *
 * The one route an `owner` or `manager` without a second factor can still reach, and deliberately
 * so: `mfa.required && !mfa.configured` is exactly the signal the dashboard's `/mfa-required`
 * screen keys off, and an admin who cannot read it has no way to discover why everything else is
 * refused (docs/PLAN.md §7).
 *
 * The employee block is present for any account with a self-view, admin or not — the product's
 * position is that what your employer can see, you can see, and that includes the owner.
 */
async function getMe(ctx: RequestContext, principal: Principal): Promise<JsonResponse> {
  const organization = await getOrganization(principal.orgId);
  if (organization === undefined) {
    throw errors.internal(new Error('token names an organisation that does not exist'), {
      orgId: principal.orgId,
    });
  }

  const employee =
    principal.employeeId === null
      ? undefined
      : await getEmployee(principal.orgId, principal.employeeId);

  ctx.log.debug('me resolved', { hasEmployee: employee !== undefined });

  return ok({
    user: {
      id: principal.userId,
      email: principal.email,
      role: principal.role,
    },
    organization: {
      id: organization.id,
      name: organization.name,
      timezone: organization.timezone,
    },
    employee:
      employee === undefined
        ? null
        : {
            id: employee.id,
            full_name: employee.full_name,
            email: employee.email,
            timezone: employee.timezone,
            status: employee.status,
          },
    mfa: {
      configured: principal.mfa,
      /** True for the roles D7 gates. The dashboard routes these users to enrolment. */
      required: principal.role === 'owner' || principal.role === 'manager',
    },
  });
}

// ---------------------------------------------------------------------------
// GET /v1/overview
// ---------------------------------------------------------------------------

async function getOverview(ctx: RequestContext, principal: Principal): Promise<JsonResponse> {
  const query = parseQuery(overviewQuery, ctx);

  const organization = await getOrganization(principal.orgId);
  if (organization === undefined) {
    throw errors.internal(new Error('token names an organisation that does not exist'), {
      orgId: principal.orgId,
    });
  }

  // "Today" is the organisation's today, not the container's: a Lambda in ap-south-1 runs on UTC,
  // where the Indian working day straddles midnight.
  const date = query.date ?? localDateOf(new Date(), organization.timezone);
  const trendFrom = shiftDate(date, -(OVERVIEW_TREND_DAYS - 1));

  const [totals, team, active, trend, feed] = await Promise.all([
    getDayTotals(principal.orgId, date),
    listTeamDay(principal.orgId, date, false),
    listActiveDevices(principal.orgId, ACTIVE_WITHIN_SECONDS, OVERVIEW_FEED_LIMIT),
    getTrend(principal.orgId, trendFrom, date),
    listRecentActivity(principal.orgId, OVERVIEW_FEED_LIMIT),
  ]);

  return ok({
    date,
    timezone: organization.timezone,
    totals,
    team: team.map((row) => ({
      employee_id: row.employee_id,
      full_name: row.full_name,
      active_seconds: row.active_seconds,
      idle_seconds: row.idle_seconds,
      total_seconds: row.total_seconds,
      first_activity_at: isoOrNull(row.first_activity_at),
      last_activity_at: isoOrNull(row.last_activity_at),
      screenshot_count: row.screenshot_count,
      last_seen_at: isoOrNull(row.last_seen_at),
      device_count: row.device_count,
    })),
    active_now: active.map((row) => ({
      employee_id: row.employee_id,
      full_name: row.full_name,
      device_id: row.device_id,
      hostname: row.hostname,
      agent_version: row.agent_version,
      last_seen_at: row.last_seen_at.toISOString(),
    })),
    trend,
    /**
     * The feed carries the app and the host but no window or page title. A live ticker of every
     * title in the organisation, on the first screen an admin opens, is not something this product
     * offers — a title can name a document, a client or a diagnosis, and reading one stays a
     * deliberate act with an employee's name attached to it.
     */
    recent_activity: feed.map((row) => ({
      id: row.id,
      employee_id: row.employee_id,
      full_name: row.full_name,
      event_type: row.event_type,
      captured_at: row.captured_at.toISOString(),
      duration_seconds: row.duration_seconds,
      app_name: row.app_name,
      url_host: row.url_host,
      is_idle: row.is_idle,
    })),
  });
}

/**
 * Adds days to a `YYYY-MM-DD` date.
 *
 * Calendar arithmetic in UTC rather than millisecond arithmetic in a zone: a local day is 23 or 25
 * hours long on a DST transition, so `- 7 * 86_400_000` lands on the wrong date twice a year in
 * any zone that observes it.
 */
function shiftDate(date: string, days: number): string {
  const asUtc = new Date(`${date}T00:00:00.000Z`);
  asUtc.setUTCDate(asUtc.getUTCDate() + days);
  return asUtc.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// GET /v1/employees
// ---------------------------------------------------------------------------

async function getEmployees(ctx: RequestContext, principal: Principal): Promise<JsonResponse> {
  const query = parseQuery(employeeListQuery, ctx);
  const rows = await listEmployees(principal.orgId, query.status);
  return ok({ employees: rows, count: rows.length });
}

// ---------------------------------------------------------------------------
// GET /v1/timesheets  and  GET /v1/employees/{id}/timesheets
// ---------------------------------------------------------------------------

function presentTimesheet(row: TimesheetRow): Record<string, unknown> {
  return {
    id: row.id,
    employee_id: row.employee_id,
    full_name: row.full_name,
    work_date: row.work_date,
    timezone: row.timezone,
    active_seconds: row.active_seconds,
    idle_seconds: row.idle_seconds,
    total_seconds: row.total_seconds,
    first_activity_at: isoOrNull(row.first_activity_at),
    last_activity_at: isoOrNull(row.last_activity_at),
    screenshot_count: row.screenshot_count,
    source_event_count: row.source_event_count,
    version: row.version,
    computed_at: row.computed_at.toISOString(),
  };
}

interface BreakdownEntry {
  label: string;
  seconds: number;
}

interface ProjectBreakdownEntry extends BreakdownEntry {
  project_id: string | null;
}

interface Breakdown {
  apps: BreakdownEntry[];
  sites: BreakdownEntry[];
  categories: BreakdownEntry[];
  projects: ProjectBreakdownEntry[];
}

function emptyBreakdown(): Breakdown {
  return { apps: [], sites: [], categories: [], projects: [] };
}

/** Groups the union-shaped breakdown rows back under their timesheet. */
function groupBreakdown(rows: readonly BreakdownRow[]): Map<string, Breakdown> {
  const grouped = new Map<string, Breakdown>();

  for (const row of rows) {
    let entry = grouped.get(row.timesheet_id);
    if (entry === undefined) {
      entry = emptyBreakdown();
      grouped.set(row.timesheet_id, entry);
    }

    switch (row.kind) {
      case 'app':
        entry.apps.push({ label: row.label, seconds: row.seconds });
        break;
      case 'site':
        entry.sites.push({ label: row.label, seconds: row.seconds });
        break;
      case 'category':
        entry.categories.push({ label: row.label, seconds: row.seconds });
        break;
      case 'project':
        entry.projects.push({
          project_id: row.project_id,
          label: row.label,
          seconds: row.seconds,
        });
        break;
    }
  }

  return grouped;
}

/** `GET /v1/timesheets` — the whole team, or one employee when asked for by query parameter. */
async function getTeamTimesheets(
  ctx: RequestContext,
  principal: Principal,
): Promise<JsonResponse> {
  const query = parseQuery(timesheetRangeQuery, ctx);

  // The query parameter is an input to the scope decision, not the decision: an `employee` who
  // passes somebody else's id is refused, and one who passes none is scoped to themselves anyway.
  // `POLICY.adminRead` has already required an admin role and, for one, MFA. The scope call is
  // still what produces the employee filter, so a future widening of the route's roles cannot
  // accidentally hand an employee the whole organisation's timesheets.
  const scope = resolveEmployeeScope(principal, query.employee_id);

  const rows = await listTimesheets(
    scope.orgId,
    query.from,
    query.to,
    scope.employeeId,
    query.limit,
  );

  return ok({
    from: query.from,
    to: query.to,
    employee_id: scope.employeeId,
    timesheets: rows.map(presentTimesheet),
    count: rows.length,
    truncated: rows.length === query.limit,
  });
}

/** `GET /v1/employees/{id}/timesheets` — one person, with optional per-day breakdowns. */
async function getEmployeeTimesheets(
  ctx: RequestContext,
  principal: Principal,
  params: RouteParams,
): Promise<JsonResponse> {
  const query = parseQuery(employeeTimesheetQuery, ctx);
  const subject = await loadSubject(principal, params);

  const rows = await listTimesheets(
    principal.orgId,
    query.from,
    query.to,
    subject.employeeId,
    // A day per row over the range cap, plus headroom: this list cannot exceed the range.
    500,
  );

  const breakdown = query.include_breakdown
    ? groupBreakdown(await getTimesheetBreakdown(rows.map((row) => row.id)))
    : undefined;

  return ok({
    employee: {
      id: subject.employeeId,
      full_name: subject.fullName,
      timezone: subject.timezone,
    },
    from: query.from,
    to: query.to,
    timesheets: rows.map((row) => ({
      ...presentTimesheet(row),
      ...(breakdown === undefined
        ? {}
        : { breakdown: breakdown.get(row.id) ?? emptyBreakdown() }),
    })),
    count: rows.length,
  });
}

// ---------------------------------------------------------------------------
// GET /v1/employees/{id}/activity
// ---------------------------------------------------------------------------

/**
 * One employee's raw activity for one day.
 *
 * The only per-employee read of `activity_events` in the dashboard, and it is bounded on both
 * axes: a single employee-day range scan on `activity_events_employee_time_idx`, keyset-paginated
 * with a capped page size. The date is a required parameter rather than an optional filter for
 * exactly that reason — optional would mean "their entire history" by default.
 */
async function getEmployeeActivity(
  ctx: RequestContext,
  principal: Principal,
  params: RouteParams,
): Promise<JsonResponse> {
  const query = parseQuery(activityQuery, ctx);
  const subject = await loadSubject(principal, params);
  const { start, end } = dayBounds(query.date, subject.timezone);

  const rows = await listEmployeeActivity(
    principal.orgId,
    subject.employeeId,
    start,
    end,
    query.cursor,
    query.limit,
  );

  return ok({
    employee_id: subject.employeeId,
    date: query.date,
    timezone: subject.timezone,
    events: rows.map((row) => ({
      id: row.id,
      device_id: row.device_id,
      event_type: row.event_type,
      captured_at: row.captured_at.toISOString(),
      duration_seconds: row.duration_seconds,
      app_name: row.app_name,
      app_exe: row.app_exe,
      window_title: row.window_title,
      url_host: row.url_host,
      url_title: row.url_title,
      category: row.category,
      project_id: row.project_id,
      project_name: row.project_name,
      is_idle: row.is_idle,
    })),
    next_cursor: nextCursor(rows, query.limit, (row) => ({ at: row.captured_at, id: row.id })),
  });
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

/**
 * `GET /v1/employees/{id}/screenshots` — the gallery for one day.
 *
 * Audited: opening someone's screenshot gallery is an access to their data whether or not any
 * individual image is then fetched, and an audit trail that only recorded the second half would
 * make "who has been looking at this person's screen" unanswerable.
 */
async function getScreenshots(
  ctx: RequestContext,
  principal: Principal,
  params: RouteParams,
): Promise<JsonResponse> {
  const query = parseQuery(screenshotListQuery, ctx);
  const subject = await loadSubject(principal, params);
  const { start, end } = dayBounds(query.date, subject.timezone);

  await recordAudit(ctx, principal, {
    action: AuditAction.SCREENSHOT_LIST,
    subjectType: 'employee',
    subjectId: subject.employeeId,
    subjectEmployeeId: subject.employeeId,
    metadata: { date: query.date, self: subject.employeeId === principal.employeeId },
  });

  const rows = await listScreenshots(
    principal.orgId,
    subject.employeeId,
    start,
    end,
    query.cursor,
    query.limit,
  );

  return ok({
    employee_id: subject.employeeId,
    date: query.date,
    timezone: subject.timezone,
    screenshots: rows.map((row) => ({
      id: row.id,
      device_id: row.device_id,
      captured_at: row.captured_at.toISOString(),
      width: row.width,
      height: row.height,
      byte_count: row.byte_count,
      content_type: row.content_type,
      /** Surfaced so a viewer always knows whether the blur privacy control was applied. */
      blurred: row.blurred,
    })),
    next_cursor: nextCursor(rows, query.limit, (row) => ({ at: row.captured_at, id: row.id })),
  });
}

/**
 * `GET /v1/employees/{id}/screenshots/{sid}/url` — a short-lived presigned GET.
 *
 * **The audit row is written before the URL is generated, and nothing here catches its failure.**
 * That ordering is the control, not a stylistic preference. Presigning first and auditing second
 * means any failure between the two — a lost connection, a rolled-back transaction, a container
 * killed mid-invocation — yields a working URL to a screenshot of someone's screen with no record
 * that it was ever issued. Auditing first can at worst record a view that then failed, which is a
 * trail slightly ahead of reality; the reverse is a trail quietly behind it, and a trail that can
 * fall behind an access is not evidence of anything.
 *
 * The URL lives for `PRESIGN_VIEW_EXPIRY_SECONDS` (300 by default), deliberately shorter than the
 * 900 seconds an upload URL gets: this one grants a human read access to an image of an employee's
 * screen, and its useful life is the seconds between the click and the image rendering.
 */
async function issueScreenshotUrl(
  ctx: RequestContext,
  principal: Principal,
  params: RouteParams,
): Promise<JsonResponse> {
  const subject = await loadSubject(principal, params);

  const screenshotId = params.sid;
  if (screenshotId === undefined) throw errors.notFound('Screenshot');

  const screenshot = await findViewableScreenshot(
    principal.orgId,
    subject.employeeId,
    screenshotId,
  );

  // Scoped by employee as well as organisation, so an id belonging to someone else is "not found"
  // rather than a second authorisation check somebody has to remember to write.
  if (screenshot === undefined) throw errors.notFound('Screenshot');

  if (screenshot.upload_state !== 'uploaded') {
    // `pending` means the agent asked for an upload URL and never used it; `expired` means the
    // retention sweeper has already deleted the object. Presigning either would hand over a URL
    // that 404s at S3, and would record an access that could not have happened.
    throw errors.notFound('Screenshot');
  }

  await recordAudit(ctx, principal, {
    action: AuditAction.SCREENSHOT_VIEW,
    subjectType: 'screenshot',
    subjectId: screenshot.id,
    subjectEmployeeId: subject.employeeId,
    metadata: {
      captured_at: screenshot.captured_at.toISOString(),
      blurred: screenshot.blurred,
      self: subject.employeeId === principal.employeeId,
    },
  });

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: screenshot.s3_bucket,
      Key: screenshot.s3_key,
      // Pinned into the signature so the URL cannot be reused to make the object render as
      // something else in a browser, and so it is never cached by an intermediary.
      ResponseContentType: screenshot.content_type,
      ResponseCacheControl: 'no-store',
    }),
    { expiresIn: config.PRESIGN_VIEW_EXPIRY_SECONDS },
  );

  ctx.log.info('screenshot url issued', {
    screenshotId: screenshot.id,
    employeeId: subject.employeeId,
    expiresIn: config.PRESIGN_VIEW_EXPIRY_SECONDS,
  });

  return ok({
    screenshot_id: screenshot.id,
    url,
    expires_in_seconds: config.PRESIGN_VIEW_EXPIRY_SECONDS,
    captured_at: screenshot.captured_at.toISOString(),
    blurred: screenshot.blurred,
    content_type: screenshot.content_type,
  });
}

// ---------------------------------------------------------------------------
// GET /v1/reports/export
// ---------------------------------------------------------------------------

const EXPORT_HEADER = [
  'work_date',
  'employee_name',
  'employee_email',
  'external_ref',
  'timezone',
  'active_hours',
  'idle_hours',
  'total_hours',
  'active_seconds',
  'idle_seconds',
  'total_seconds',
  'first_activity_at',
  'last_activity_at',
  'screenshot_count',
  'source_event_count',
] as const;

/** Seconds as decimal hours to two places — what a payroll sheet actually wants to multiply. */
function hours(seconds: number): string {
  return (seconds / 3600).toFixed(2);
}

function exportCells(row: ExportRow): readonly (string | number | null)[] {
  return [
    row.work_date,
    row.full_name,
    row.email,
    row.external_ref,
    row.timezone,
    hours(row.active_seconds),
    hours(row.idle_seconds),
    hours(row.total_seconds),
    row.active_seconds,
    row.idle_seconds,
    row.total_seconds,
    isoOrNull(row.first_activity_at),
    isoOrNull(row.last_activity_at),
    row.screenshot_count,
    row.source_event_count,
  ];
}

/**
 * The payroll export.
 *
 * Audited before a single row is read, on the same reasoning as the screenshot URL: this is a bulk
 * read of every monitored person's hours, and it is the read most likely to be asked about later.
 *
 * The CSV is produced by a generator over keyset-paginated pages, so the Lambda holds one page and
 * one 64 KB chunk regardless of range (`src/export/csv.ts`). It is then returned base64-encoded
 * inside a JSON envelope, which needs explaining: `src/shared/http.ts` serialises every response
 * body with `JSON.stringify`, so a raw `text/csv` body is not expressible through the shared
 * wrapper, and changing that wrapper is outside this change's scope. Base64 keeps the BOM and the
 * CRLF line endings byte-exact through a JSON transport, and the dashboard already assembles a
 * download client-side for the PDF path (docs/PLAN.md §4), so the same code path serves both.
 */
async function exportTimesheets(
  ctx: RequestContext,
  principal: Principal,
): Promise<JsonResponse> {
  const query = parseQuery(exportQuery, ctx);

  const scope = resolveEmployeeScope(principal, query.employee_id);
  assertAdminMfaForSubject(principal, scope.employeeId);

  await recordAudit(ctx, principal, {
    action: AuditAction.TIMESHEET_EXPORT,
    subjectType: scope.employeeId === null ? 'organization' : 'employee',
    subjectId: scope.employeeId ?? principal.orgId,
    subjectEmployeeId: scope.employeeId,
    metadata: { format: 'csv', from: query.from, to: query.to },
  });

  const rows = iterateExportRows(scope.orgId, query.from, query.to, scope.employeeId);
  // A property rather than a `let`: the increment happens either side of an await, which is
  // exactly the shape `require-atomic-updates` exists to flag on a bare variable.
  const counted = { rows: 0 };

  async function* cells(): AsyncGenerator<readonly (string | number | null)[], void, undefined> {
    for await (const row of rows) {
      counted.rows += 1;
      yield exportCells(row);
    }
  }

  const collected = await collectCsv(encodeCsv(EXPORT_HEADER, cells()), MAX_EXPORT_CSV_BYTES);

  const filename =
    scope.employeeId === null
      ? `worklens-timesheets-${query.from}_${query.to}.csv`
      : `worklens-timesheets-${scope.employeeId}-${query.from}_${query.to}.csv`;

  ctx.log.info('timesheet export produced', {
    rows: counted.rows,
    bytes: collected.byteCount,
    from: query.from,
    to: query.to,
  });

  return ok({
    filename,
    content_type: 'text/csv; charset=utf-8',
    encoding: 'base64',
    byte_count: collected.byteCount,
    row_count: counted.rows,
    content: collected.body.toString('base64'),
  });
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * The route table.
 *
 * Every entry carries its own policy, so "who may call this" is part of the route's definition
 * rather than something a handler is trusted to check. Two notes on what is *not* here:
 *
 *  - `GET /v1/audit-log` lives in `admin.ts`, because `infra/modules/api/main.tf` routes it at the
 *    `admin-api` function. Putting it here would make it unreachable in a deployed stack.
 *  - `POST /v1/aggregation/run` is routed straight at `aggregate-timesheets` for the reason that
 *    module's comment gives: an in-VPC Lambda cannot reach the Lambda control plane without a NAT
 *    gateway (D6), so `admin-api` cannot invoke it. It uses `withCognitoAuth` from
 *    `src/middleware/cognitoAuth.ts` to get the same authentication, roles and D7 gate.
 */
const router = createDashboardRouter([
  { method: 'GET', path: '/me', policy: POLICY.self, handler: getMe },
  { method: 'GET', path: '/overview', policy: POLICY.adminRead, handler: getOverview },
  { method: 'GET', path: '/employees', policy: POLICY.adminRead, handler: getEmployees },
  {
    method: 'GET',
    path: '/employees/{id}/timesheets',
    policy: POLICY.employeeRead,
    handler: getEmployeeTimesheets,
  },
  {
    method: 'GET',
    path: '/employees/{id}/activity',
    policy: POLICY.employeeRead,
    handler: getEmployeeActivity,
  },
  {
    method: 'GET',
    path: '/employees/{id}/screenshots',
    policy: POLICY.employeeRead,
    handler: getScreenshots,
  },
  {
    method: 'GET',
    path: '/employees/{id}/screenshots/{sid}/url',
    policy: POLICY.employeeRead,
    handler: issueScreenshotUrl,
  },
  { method: 'GET', path: '/timesheets', policy: POLICY.adminRead, handler: getTeamTimesheets },
  { method: 'GET', path: '/reports/export', policy: POLICY.adminRead, handler: exportTimesheets },
]);

export const handler = withHandler('reporting-api', router);
