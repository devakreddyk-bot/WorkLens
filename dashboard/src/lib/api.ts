/**
 * The API client. Server-side only.
 *
 * Every function here runs in a Server Component or a Server Action, reads the access token from an
 * `httpOnly` cookie, and attaches it. Nothing in this module is importable from a Client Component —
 * `next/headers` makes that a build error, which is the enforcement rather than a convention.
 *
 * # It does not decide anything
 *
 * The client sends a request and renders what comes back. It never checks a role before calling, and
 * it never filters a response. That is not laziness: `backend/src/middleware/cognitoAuth.ts` resolves
 * scope by *rewriting the query*, so an employee asking for the team view gets a 403 and an employee
 * asking for their own data gets their own data. A dashboard that duplicated those rules would
 * eventually disagree with the server, and the disagreement would surface as somebody seeing a page
 * they should not — or, more likely, as a page that refuses a request the server would have allowed.
 *
 * The one exception is presentation: a `MFA_REQUIRED` response is turned into a redirect to
 * `/mfa-required`, because an admin without a second factor needs somewhere to go rather than an
 * error. That is still not an authorisation decision — the server has already refused.
 */

import { redirect } from 'next/navigation';

import { assertEnv, publicEnv } from './env';
import { getAccessToken } from './session';

/** The error envelope every API failure uses. Mirrors `backend/src/shared/errors.ts`. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: { field?: string; message: string }[];
    requestId: string;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Shown to support. The same id appears in the API's access log and its application log. */
  readonly requestId: string;
  readonly details: { field?: string; message: string }[] | undefined;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.error.code;
    this.requestId = body.error.requestId;
    this.details = body.error.details;
  }

  /** A field-keyed map, for rendering validation messages beside the inputs that caused them. */
  fieldErrors(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const detail of this.details ?? []) {
      if (detail.field !== undefined) map[detail.field] = detail.message;
    }
    return map;
  }
}

/** Codes the dashboard reacts to specifically. The rest render as their message. */
export const ApiErrorCode = {
  MFA_REQUIRED: 'MFA_REQUIRED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  FEATURE_DISABLED: 'FEATURE_DISABLED',
  CONFLICT: 'CONFLICT',
} as const;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /**
   * Cache behaviour. Everything defaults to `no-store`: this is one organisation's employee data, and
   * a cached timesheet served to the wrong session is the failure that matters most. A caller that
   * genuinely wants revalidation opts in.
   */
  revalidateSeconds?: number;
  /**
   * Turn a `MFA_REQUIRED` refusal into a redirect. On by default; `/v1/me` and the MFA page itself
   * pass false, or the redirect would loop.
   */
  redirectOnMfaRequired?: boolean;
}

function buildUrl(path: string, query: RequestOptions['query']): string {
  assertEnv();

  const base = publicEnv.apiBaseUrl.replace(/\/$/, '');
  const url = new URL(base + (path.startsWith('/') ? path : `/${path}`));

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

/**
 * Performs one authenticated request.
 *
 * A 401 redirects to login: the access token has expired or been revoked, and there is nothing the
 * page can do but ask the person to sign in again. Everything else becomes an `ApiError` for the
 * caller — a page that knows a 404 means "no timesheet for that day" can say so better than a generic
 * handler could.
 */
async function requestRaw(
  path: string,
  options: RequestOptions,
  accept: string,
): Promise<{ response: Response; text: string }> {
  const token = await getAccessToken();
  if (token === null) {
    redirect('/login');
  }

  const method = options.method ?? 'GET';
  const url = buildUrl(path, options.query);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: accept,
  };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.revalidateSeconds === undefined
        ? { cache: 'no-store' as const }
        : { next: { revalidate: options.revalidateSeconds } }),
    });
  } catch (cause) {
    // A transport failure is not an API error and must not be rendered as one — "the API said
    // ECONNREFUSED" is nonsense. Named as unreachable so the page can say the right thing.
    throw new Error(
      `The WorkLens API at ${publicEnv.apiBaseUrl} could not be reached. ` +
        `If this persists, check the deployment is running.`,
      { cause },
    );
  }

  if (response.status === 401) {
    redirect('/login?reason=expired');
  }

  const text = response.status === 204 ? '' : await response.text();

  if (!response.ok) {
    const body = parseErrorBody(response.status, text);
    const error = new ApiError(response.status, body);

    if (error.code === ApiErrorCode.MFA_REQUIRED && (options.redirectOnMfaRequired ?? true)) {
      redirect('/mfa-required');
    }

    throw error;
  }

  return { response, text };
}

/**
 * A JSON request. Everything except the export uses this.
 *
 * A 401 redirects to login: the access token has expired or been revoked, and there is nothing the
 * page can do but ask the person to sign in again. Everything else becomes an `ApiError`.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { response, text } = await requestRaw(path, options, 'application/json');

  if (text === '') {
    return undefined as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new Error(`The API returned a response that is not JSON (HTTP ${response.status}).`, { cause });
  }
}

/**
 * A request whose response is a file rather than JSON.
 *
 * Only `GET /v1/reports/export` uses this. It shares the whole transport with `apiRequest` — token,
 * URL building, the 401 redirect, the MFA redirect and the error envelope — and differs only in not
 * parsing the body, because the body is a CSV.
 *
 * The filename comes from `Content-Disposition` rather than being rebuilt here. The server already
 * decides it from the range and the employee scope, and two places computing a filename is two
 * places to disagree about which day a spreadsheet covers.
 */
export async function apiRequestFile(
  path: string,
  options: RequestOptions = {},
): Promise<{ content: string; filename: string; contentType: string }> {
  const { response, text } = await requestRaw(path, options, 'text/csv');

  return {
    content: text,
    filename: filenameFromDisposition(response.headers.get('content-disposition')),
    contentType: response.headers.get('content-type') ?? 'application/octet-stream',
  };
}

/**
 * The filename from a `Content-Disposition` header.
 *
 * Falls back to a generic name rather than throwing: a missing header is a reason to give the file a
 * duller name, not a reason to lose an export somebody waited for. The value is stripped of path
 * separators — it becomes a download filename, and a server that sent `../` should not get to choose
 * where a browser writes.
 */
function filenameFromDisposition(header: string | null): string {
  const fallback = 'worklens-timesheets.csv';
  if (header === null) return fallback;

  const match = /filename\s*=\s*"([^"]+)"/i.exec(header) ?? /filename\s*=\s*([^;]+)/i.exec(header);
  const raw = match?.[1]?.trim();
  if (raw === undefined || raw === '') return fallback;

  const cleaned = raw.replace(/[/\\]/g, '_').replace(/^\.+/, '');
  return cleaned === '' ? fallback : cleaned;
}

/**
 * Parses an error body, synthesising one when the response did not come from the API.
 *
 * A WAF block, an API Gateway throttle or a captive portal all answer with something that is not the
 * error envelope. Synthesising keeps the type honest and preserves the status, which is usually the
 * only diagnostic available.
 */
function parseErrorBody(status: number, text: string): ApiErrorBody {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'error' in parsed &&
      typeof (parsed as ApiErrorBody).error?.code === 'string'
    ) {
      return parsed as ApiErrorBody;
    }
  } catch {
    // Fall through to the synthesised envelope.
  }

  return {
    error: {
      code: status === 429 ? 'RATE_LIMITED' : 'UNEXPECTED_RESPONSE',
      message:
        status === 429
          ? 'Too many requests. Wait a moment and try again.'
          : `The API returned HTTP ${status}.`,
      requestId: 'unknown',
    },
  };
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------
// Declared as interfaces rather than re-exported from the backend's Zod schemas, and that is worth
// explaining because docs/PLAN.md D1 justifies TypeScript on the backend partly by the shared
// contract.
//
// The dashboard and the backend are separate deployments — Vercel and Lambda — with separate installs
// and no build-time link between them. Importing across that boundary would mean either a published
// package or a path alias into ../backend, and the second one breaks the moment the dashboard is
// deployed on its own. What the shared schemas genuinely buy is inside the backend: one definition
// used by the handler and its tests. Here, the types are declared to match and the API's own
// validation is what enforces the contract at run time.
//
// The cost of that decision is that these declarations are a copy, and a copy drifts. It already
// did: they were first written from docs/PLAN.md instead of from the handlers, and called two routes
// that do not exist. `tsc` cannot catch that — each tier is internally consistent, which is the
// point of the separation — so `scripts/check-routes.sh` compares the paths called here against the
// backend's route tables on every CI run. It covers paths and methods, not field names; if you
// change a shape below, read the handler.

//
// Every shape below was read off the handlers in `backend/src/handlers/dashboard/` rather than off
// docs/PLAN.md, and where the two disagree the handler wins — it is the thing that will actually
// answer. Two consequences worth stating, because they are easy to get wrong from the plan alone:
// there is no `/timesheets/team` route (the team register is a projection of `/overview`), and the
// per-day breakdown is not its own route but an `include_breakdown` flag on the timesheets range.
//
// Every `timestamptz` arrives as an ISO string: `backend/src/shared/http.ts` serialises bodies with
// `JSON.stringify`, which is what turns the repository's `Date` into text. Declared as `string` here
// rather than `Date` so nothing is tempted to call a date method on something that has none.

export interface Me {
  user: { id: string; email: string; role: 'owner' | 'manager' | 'employee' };
  organization: { id: string; name: string; timezone: string };
  /**
   * Present for any account with a self-view, admin or not. Null is an admin-only account — a
   * bookkeeper with no monitored machine — and `/me` has to say so rather than render an empty day.
   */
  employee: {
    id: string;
    full_name: string;
    email: string;
    timezone: string;
    status: 'active' | 'inactive';
  } | null;
  mfa: { configured: boolean; required: boolean };
}

export interface DayTotals {
  active_seconds: number;
  idle_seconds: number;
  total_seconds: number;
  screenshot_count: number;
  employees_with_activity: number;
}

export interface TrendDay {
  work_date: string;
  active_seconds: number;
  idle_seconds: number;
  employees_with_activity: number;
}

/** One employee's day, as the overview reports it. A left join, so a quiet day is zeroes not absence. */
export interface TeamMemberDay {
  employee_id: string;
  full_name: string;
  active_seconds: number;
  idle_seconds: number;
  total_seconds: number;
  first_activity_at: string | null;
  last_activity_at: string | null;
  screenshot_count: number;
  last_seen_at: string | null;
  device_count: number;
}

export interface ActiveDevice {
  employee_id: string;
  full_name: string;
  device_id: string;
  hostname: string;
  agent_version: string;
  last_seen_at: string;
}

/** The overview feed. No window or page title — see the note on `listRecentActivity`. */
export interface RecentActivity {
  id: string;
  employee_id: string;
  full_name: string;
  event_type: string;
  captured_at: string;
  duration_seconds: number;
  app_name: string | null;
  url_host: string | null;
  is_idle: boolean;
}

export interface OverviewResponse {
  date: string;
  timezone: string;
  totals: DayTotals;
  team: TeamMemberDay[];
  active_now: ActiveDevice[];
  trend: TrendDay[];
  recent_activity: RecentActivity[];
}

export interface BreakdownEntry {
  label: string;
  seconds: number;
}

export interface ProjectBreakdownEntry extends BreakdownEntry {
  project_id: string | null;
}

export interface TimesheetBreakdown {
  apps: BreakdownEntry[];
  sites: BreakdownEntry[];
  categories: BreakdownEntry[];
  projects: ProjectBreakdownEntry[];
}

export interface TimesheetRow {
  id: string;
  employee_id: string;
  full_name: string;
  work_date: string;
  timezone: string;
  active_seconds: number;
  idle_seconds: number;
  total_seconds: number;
  first_activity_at: string | null;
  last_activity_at: string | null;
  screenshot_count: number;
  source_event_count: number;
  version: number;
  computed_at: string;
  /** Present only when the request asked for it. */
  breakdown?: TimesheetBreakdown;
}

export interface EmployeeTimesheetsResponse {
  employee: { id: string; full_name: string; timezone: string };
  from: string;
  to: string;
  timesheets: TimesheetRow[];
  count: number;
}

export interface TeamTimesheetsResponse {
  from: string;
  to: string;
  employee_id: string | null;
  timesheets: TimesheetRow[];
  count: number;
  truncated: boolean;
}

/**
 * One recorded event. `window_title` and `url_title` appear here and nowhere else in the API: reading
 * what somebody had open stays behind the deliberate act of opening one employee's one day.
 */
export interface ActivityRow {
  id: string;
  device_id: string;
  event_type: string;
  captured_at: string;
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

export interface ActivityResponse {
  employee_id: string;
  date: string;
  timezone: string;
  events: ActivityRow[];
  next_cursor: string | null;
}

export interface ScreenshotRow {
  id: string;
  device_id: string;
  captured_at: string;
  width: number;
  height: number;
  byte_count: number;
  content_type: string;
  /** Surfaced everywhere a screenshot appears, so a viewer always knows what they are looking at. */
  blurred: boolean;
}

export interface ScreenshotsResponse {
  employee_id: string;
  date: string;
  timezone: string;
  screenshots: ScreenshotRow[];
  next_cursor: string | null;
}

export interface ScreenshotUrlResponse {
  screenshot_id: string;
  url: string;
  expires_in_seconds: number;
  captured_at: string;
  blurred: boolean;
  content_type: string;
}

export interface EmployeeRecordRow {
  id: string;
  full_name: string;
  email: string;
  external_ref: string | null;
  timezone: string;
  status: 'active' | 'inactive';
  hired_on: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The mutable half of `monitoring_config`.
 *
 * `PUT /v1/config` takes exactly this object and nothing less: a partial update would let an owner
 * change screenshot capture without ever restating the exclusion list that ships alongside it. The
 * settings screen is built around that — it holds every field, and diffs the whole object.
 */
export interface MonitoringConfig {
  sample_interval_seconds: number;
  idle_threshold_seconds: number;
  capture_window_titles: boolean;
  capture_urls: boolean;
  screenshot_enabled: boolean;
  screenshot_interval_seconds: number;
  screenshot_blur: boolean;
  work_hours_only: boolean;
  /** `HH:MM:SS`, as Postgres renders a `time`. */
  work_hours_start: string;
  work_hours_end: string;
  /** ISO-8601 weekdays: 1 = Monday … 7 = Sunday. */
  work_days: number[];
  excluded_apps: string[];
  excluded_url_patterns: string[];
  retention_days_events: number;
  retention_days_screenshots: number;
}

export interface MonitoringConfigResponse {
  config: MonitoringConfig;
  config_version: number;
}

export interface MonitoringConfigSaved extends MonitoringConfigResponse {
  /** The keys the server saw change. Compared against the dialog's own diff, not trusted blindly. */
  changed_keys: string[];
}

export interface ProjectRow {
  id: string;
  name: string;
  code: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export type ProjectMatchType = 'app_exe' | 'url_host' | 'title_contains' | 'title_regex';

export interface ProjectRuleRow {
  id: string;
  project_id: string;
  match_type: ProjectMatchType;
  pattern: string;
  priority: number;
  created_at: string;
}

export interface DashboardUserRow {
  id: string;
  cognito_sub: string;
  email: string;
  role: 'owner' | 'manager' | 'employee';
  employee_id: string | null;
  employee_name: string | null;
  status: 'active' | 'disabled';
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeviceRow {
  id: string;
  employee_id: string;
  full_name: string;
  hostname: string;
  os: string;
  os_version: string;
  agent_version: string;
  key_version: number;
  enrolled_at: string;
  last_seen_at: string | null;
  last_config_fetch_at: string | null;
  notice_acknowledged_at: string | null;
  revoked_at: string | null;
}

export interface EnrollmentTokenIssued {
  enrollment_token_id: string;
  employee_id: string;
  /** Shown once. It is not stored anywhere the dashboard can read it back. */
  token: string;
  expires_at: string;
  detail: string;
}

export type DeletionScope = 'all' | 'screenshots' | 'events';

export interface DeletionRequestRow {
  id: string;
  employee_id: string;
  full_name: string | null;
  scope: DeletionScope;
  requested_by_user_id: string | null;
  reason: string | null;
  requested_at: string;
  status: 'pending' | 'completed' | 'failed';
  completed_at: string | null;
  deleted_event_count: number | null;
  deleted_screenshot_count: number | null;
  error: string | null;
}

export interface AuditEntryRow {
  id: string;
  created_at: string;
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
}

export interface AuditLogResponse {
  entries: AuditEntryRow[];
  count: number;
  next_cursor: string | null;
}

/**
 * The CSV export, as it arrives.
 *
 * A real `text/csv` body with a `Content-Disposition` filename. It used to be base64 inside a JSON
 * envelope, because the backend's shared response wrapper serialised every body with
 * `JSON.stringify`; that wrapper now has a raw branch (`raw`/`attachment` in
 * `backend/src/shared/http.ts`), so this is a plain download and the envelope is gone.
 */
export interface CsvExport {
  /** The file's bytes as text, byte-order mark and CRLF line endings included. */
  content: string;
  filename: string;
  contentType: string;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/**
 * The caller's own identity.
 *
 * `redirectOnMfaRequired: false` because this is the one route the server deliberately leaves
 * ungated — an admin without a factor has to be able to load the shell in order to reach the
 * enrolment screen. Redirecting here would loop.
 */
export function fetchMe(): Promise<Me> {
  return apiRequest<Me>('/me', { redirectOnMfaRequired: false });
}

/**
 * The overview, which is also the source for the team register.
 *
 * `/overview` carries `team`, and `/timesheets` does not carry the same thing: the former is a left
 * join from `employees`, so somebody who recorded nothing appears with zeroes, and the latter only
 * returns timesheet rows that exist. On a team register those are different pages — "nobody recorded
 * any time" and "that person is not in the list" look identical to a reader, and only one of them is
 * a reason to go and check whether an agent has stopped reporting.
 */
export function fetchOverview(date?: string): Promise<OverviewResponse> {
  return apiRequest<OverviewResponse>('/overview', { query: { date } });
}

export function fetchEmployees(
  status: 'active' | 'inactive' | 'all' = 'active',
): Promise<{ employees: EmployeeRecordRow[]; count: number }> {
  return apiRequest('/employees', { query: { status } });
}

/** The whole organisation's timesheets over a range, or one person's when named. */
export function fetchTeamTimesheets(
  from: string,
  to: string,
  employeeId?: string,
): Promise<TeamTimesheetsResponse> {
  return apiRequest('/timesheets', { query: { from, to, employee_id: employeeId } });
}

/**
 * One employee's timesheets over a range.
 *
 * `includeBreakdown` is off by default because the breakdown is four extra reads per day and a week
 * view that only draws bands does not need them.
 */
export function fetchEmployeeTimesheets(
  employeeId: string,
  from: string,
  to: string,
  includeBreakdown = false,
): Promise<EmployeeTimesheetsResponse> {
  return apiRequest(`/employees/${encodeURIComponent(employeeId)}/timesheets`, {
    query: { from, to, include_breakdown: includeBreakdown ? 'true' : 'false' },
  });
}

/**
 * One employee's recorded activity for one day, keyset-paginated.
 *
 * `limit` is exposed because the caller's reason for reading this varies: the register shows a page,
 * and the day-band needs *every* span before it can draw them individually — a band drawn from half a
 * day's spans is a picture of a shorter day, which is worse than no picture.
 */
export function fetchEmployeeActivity(
  employeeId: string,
  date: string,
  cursor?: string,
  limit?: number,
): Promise<ActivityResponse> {
  return apiRequest(`/employees/${encodeURIComponent(employeeId)}/activity`, {
    query: { date, cursor, limit },
  });
}

/**
 * The screenshot gallery for one day — metadata only, no URLs.
 *
 * Listing is itself audited server-side, because opening somebody's gallery is an access to their
 * data whether or not an individual image is then fetched.
 */
export function fetchScreenshots(
  employeeId: string,
  date: string,
  cursor?: string,
): Promise<ScreenshotsResponse> {
  return apiRequest(`/employees/${encodeURIComponent(employeeId)}/screenshots`, {
    query: { date, cursor },
  });
}

/**
 * A short-lived URL for one screenshot.
 *
 * Fetched per image, on demand, because the URL expires in 300 seconds — presigning a whole gallery up
 * front would produce a page whose images all break five minutes after it loaded. Every call is
 * recorded in the audit log before the URL is issued, which is also why they are not fetched
 * speculatively: an unviewed image should not appear in the record as viewed.
 */
export function fetchScreenshotUrl(
  employeeId: string,
  screenshotId: string,
): Promise<ScreenshotUrlResponse> {
  return apiRequest(
    `/employees/${encodeURIComponent(employeeId)}/screenshots/${encodeURIComponent(screenshotId)}/url`,
  );
}

export function fetchMonitoringConfig(): Promise<MonitoringConfigResponse> {
  return apiRequest<MonitoringConfigResponse>('/config');
}

/** A complete replacement of the monitoring configuration. Bumps `config_version`; audited. */
export function putMonitoringConfig(config: MonitoringConfig): Promise<MonitoringConfigSaved> {
  return apiRequest<MonitoringConfigSaved>('/config', { method: 'PUT', body: config });
}

export function fetchProjects(): Promise<{ projects: ProjectRow[]; count: number }> {
  return apiRequest('/projects');
}

export function fetchProjectRules(
  projectId: string,
): Promise<{ project_id: string; rules: ProjectRuleRow[]; count: number }> {
  return apiRequest(`/projects/${encodeURIComponent(projectId)}/rules`);
}

export function createProject(body: {
  name: string;
  code?: string | null;
  is_active?: boolean;
}): Promise<{ project: ProjectRow }> {
  return apiRequest('/projects', { method: 'POST', body });
}

export function patchProject(
  projectId: string,
  body: { name?: string; code?: string | null; is_active?: boolean },
): Promise<{ project: ProjectRow }> {
  return apiRequest(`/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body });
}

/**
 * Retires a project. The route is `DELETE` and the effect is deactivation — `is_active = false` —
 * because `timesheet_project_totals` cascades from `projects`, so a real delete would rewrite every
 * past breakdown that named it. The interface says "retire" for the same reason.
 */
export function deactivateProject(
  projectId: string,
): Promise<{ project: ProjectRow; deactivated: boolean; detail: string }> {
  return apiRequest(`/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
}

export function createProjectRule(
  projectId: string,
  body: { match_type: ProjectMatchType; pattern: string; priority?: number },
): Promise<{ rule: ProjectRuleRow }> {
  return apiRequest(`/projects/${encodeURIComponent(projectId)}/rules`, { method: 'POST', body });
}

export function deleteProjectRule(
  projectId: string,
  ruleId: string,
): Promise<{ rule: ProjectRuleRow; deleted: boolean }> {
  return apiRequest(
    `/projects/${encodeURIComponent(projectId)}/rules/${encodeURIComponent(ruleId)}`,
    { method: 'DELETE' },
  );
}

/**
 * The dashboard user list.
 *
 * There is no MFA column and there cannot be one: whether a second factor is configured lives in
 * Cognito and reaches the API only as a claim on the *caller's* own token. The settings page states
 * that rather than showing a blank column.
 */
export function fetchUsers(): Promise<{ users: DashboardUserRow[]; count: number }> {
  return apiRequest('/users');
}

export function createUser(body: {
  cognito_sub: string;
  email: string;
  role: 'owner' | 'manager' | 'employee';
  employee_id?: string | null;
  status?: 'active' | 'disabled';
}): Promise<{ user: DashboardUserRow }> {
  return apiRequest('/users', { method: 'POST', body });
}

export function patchUser(
  userId: string,
  body: {
    role?: 'owner' | 'manager' | 'employee';
    employee_id?: string | null;
    status?: 'active' | 'disabled';
  },
): Promise<{ user: DashboardUserRow }> {
  return apiRequest(`/users/${encodeURIComponent(userId)}`, { method: 'PATCH', body });
}

export function fetchDevices(): Promise<{ devices: DeviceRow[]; count: number }> {
  return apiRequest('/devices');
}

export function createEnrollmentToken(body: {
  employee_id: string;
  expires_in_hours?: number;
}): Promise<EnrollmentTokenIssued> {
  return apiRequest('/devices/enrollment-tokens', { method: 'POST', body });
}

export function revokeDevice(
  deviceId: string,
): Promise<{ device_id: string; employee_id: string; revoked_at: string }> {
  return apiRequest(`/devices/${encodeURIComponent(deviceId)}/revoke`, { method: 'POST' });
}

export function fetchDeletionRequests(): Promise<{
  deletion_requests: DeletionRequestRow[];
  count: number;
}> {
  return apiRequest('/deletion-requests');
}

export function createDeletionRequest(body: {
  employee_id: string;
  scope: DeletionScope;
  reason?: string;
}): Promise<{ deletion_request: DeletionRequestRow }> {
  return apiRequest('/deletion-requests', { method: 'POST', body });
}

/** The hard delete. Irreversible, and the audit rows describing it are deliberately kept. */
export function executeDeletionRequest(
  requestId: string,
): Promise<{ deletion_request: DeletionRequestRow }> {
  return apiRequest(`/deletion-requests/${encodeURIComponent(requestId)}/execute`, {
    method: 'POST',
  });
}

/** The access log. Reading it is itself recorded in it. */
export function fetchAuditLog(filters: {
  from?: string | undefined;
  to?: string | undefined;
  action?: string | undefined;
  employeeId?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}): Promise<AuditLogResponse> {
  return apiRequest('/audit-log', {
    query: {
      from: filters.from,
      to: filters.to,
      action: filters.action,
      employee_id: filters.employeeId,
      cursor: filters.cursor,
      limit: filters.limit,
    },
  });
}

/** The payroll export. Audited before a single row is read. */
export function fetchTimesheetExport(
  from: string,
  to: string,
  employeeId?: string,
): Promise<CsvExport> {
  return apiRequestFile('/reports/export', {
    query: { format: 'csv', from, to, employee_id: employeeId },
  });
}
