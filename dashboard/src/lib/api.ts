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
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = await getAccessToken();
  if (token === null) {
    redirect('/login');
  }

  const method = options.method ?? 'GET';
  const url = buildUrl(path, options.query);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
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

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();

  if (!response.ok) {
    const body = parseErrorBody(response.status, text);
    const error = new ApiError(response.status, body);

    if (error.code === ApiErrorCode.MFA_REQUIRED && (options.redirectOnMfaRequired ?? true)) {
      redirect('/mfa-required');
    }

    throw error;
  }

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

export interface Me {
  user_id: string;
  org_id: string;
  role: 'owner' | 'manager' | 'employee';
  employee_id: string | null;
  employee_name: string | null;
  email: string;
  mfa: boolean;
  organisation: { name: string; timezone: string };
}

export interface DayTotals {
  work_date: string;
  active_seconds: number;
  idle_seconds: number;
  total_seconds: number;
  employees_recorded: number;
}

export interface TeamMemberDay {
  employee_id: string;
  full_name: string;
  timezone: string;
  work_date: string;
  active_seconds: number;
  idle_seconds: number;
  total_seconds: number;
  first_activity_at: string | null;
  last_activity_at: string | null;
  screenshot_count: number;
  last_seen_at: string | null;
}

export interface TimesheetRow {
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
}

export interface TimesheetBreakdown {
  apps: { app_name: string; seconds: number }[];
  sites: { url_host: string; seconds: number }[];
  categories: { category: string; seconds: number }[];
  projects: { project_id: string; project_name: string; seconds: number }[];
}

export interface ActivityRow {
  captured_at: string;
  duration_seconds: number;
  is_idle: boolean;
  app_name: string | null;
  window_title: string | null;
  url_host: string | null;
  category: string | null;
}

export interface Paginated<T> {
  items: T[];
  next_cursor: string | null;
}

export interface ScreenshotRow {
  screenshot_id: string;
  captured_at: string;
  width: number;
  height: number;
  blurred: boolean;
}

export interface MonitoringConfig {
  config_version: number;
  sample_interval_seconds: number;
  idle_threshold_seconds: number;
  capture_window_titles: boolean;
  capture_urls: boolean;
  screenshot_enabled: boolean;
  screenshot_interval_seconds: number;
  screenshot_blur: boolean;
  work_hours_only: boolean;
  work_hours_start: string;
  work_hours_end: string;
  work_days: number[];
  excluded_apps: string[];
  excluded_url_patterns: string[];
  retention_days_events: number;
  retention_days_screenshots: number;
  updated_at: string | null;
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

export function fetchOverview(date?: string): Promise<{
  today: DayTotals;
  trend: DayTotals[];
  active_now: { employee_id: string; full_name: string; last_seen_at: string }[];
  recent_activity: ActivityRow[];
}> {
  return apiRequest('/overview', { query: { date } });
}

export function fetchTeamDay(date?: string): Promise<{ work_date: string; members: TeamMemberDay[] }> {
  return apiRequest('/timesheets/team', { query: { date } });
}

export function fetchEmployeeTimesheets(
  employeeId: string,
  from: string,
  to: string,
): Promise<{ employee: { id: string; full_name: string; timezone: string }; rows: TimesheetRow[] }> {
  return apiRequest(`/employees/${encodeURIComponent(employeeId)}/timesheets`, { query: { from, to } });
}

export function fetchTimesheetBreakdown(
  employeeId: string,
  workDate: string,
): Promise<TimesheetBreakdown> {
  return apiRequest(`/employees/${encodeURIComponent(employeeId)}/timesheets/${workDate}/breakdown`);
}

export function fetchEmployeeActivity(
  employeeId: string,
  date: string,
  cursor?: string,
): Promise<Paginated<ActivityRow>> {
  return apiRequest(`/employees/${encodeURIComponent(employeeId)}/activity`, {
    query: { date, cursor },
  });
}

export function fetchScreenshots(
  employeeId: string,
  date: string,
): Promise<Paginated<ScreenshotRow>> {
  return apiRequest(`/employees/${encodeURIComponent(employeeId)}/screenshots`, { query: { date } });
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
): Promise<{ screenshot_id: string; url: string; expires_in_seconds: number; blurred: boolean }> {
  return apiRequest(
    `/employees/${encodeURIComponent(employeeId)}/screenshots/${encodeURIComponent(screenshotId)}/url`,
  );
}

export function fetchMonitoringConfig(): Promise<MonitoringConfig> {
  return apiRequest<MonitoringConfig>('/config');
}
