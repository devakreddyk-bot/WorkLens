/**
 * Zod schemas for the dashboard API — query strings and request bodies.
 *
 * Same contract as `src/schemas/common.ts`: every rule here mirrors a constraint that already
 * exists in `backend/migrations/0001_init.sql`, and where the two differ this file is the
 * stricter one. A body that would violate a CHECK constraint is rejected at the boundary with a
 * message naming the field, rather than surfacing as a Postgres error mentioning a constraint
 * name the dashboard author cannot act on.
 *
 * Query strings are validated with the same `.strict()` discipline as bodies. That is worth the
 * mild inconvenience: `?employeeId=` instead of `?employee_id=` silently becomes "all
 * employees" under a lenient schema, which on a reporting API means quietly returning the whole
 * organisation's data to a caller who asked for one person's.
 */

import { z } from 'zod';

import { isValidTimeZone } from '../aggregation/zone.js';
import { errors } from '../shared/errors.js';
import type { RequestContext } from '../shared/http.js';

import { trimmedBounded, uuid } from './common.js';
import { issuesToDetails } from './parse.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A calendar date, `YYYY-MM-DD`, interpreted in the relevant timezone by the caller.
 *
 * Validated against the month's real length rather than handed to `Date.parse`, which rolls
 * `2026-02-30` forward to 2 March without complaint — and a date that silently becomes a
 * different date is how a payroll export ends up covering the wrong week.
 */
export const localDate = (): z.ZodType<string, z.ZodTypeDef, unknown> =>
  z
    .string()
    .regex(LOCAL_DATE_RE, 'must be a calendar date in YYYY-MM-DD form')
    .refine((value) => {
      const year = Number(value.slice(0, 4));
      const month = Number(value.slice(5, 7));
      const day = Number(value.slice(8, 10));
      if (month < 1 || month > 12) return false;
      const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
      return day >= 1 && day <= daysInMonth;
    }, 'must be a real calendar date');

/** `employees.timezone` / `organizations.timezone` — an IANA zone the runtime actually knows. */
export const timezone = (): z.ZodType<string, z.ZodTypeDef, unknown> =>
  z
    .string()
    .min(3)
    .max(64)
    .refine(isValidTimeZone, 'must be an IANA timezone name, e.g. Asia/Kolkata');

/**
 * `monitoring_config.work_hours_start` / `.work_hours_end`.
 *
 * Accepts `HH:MM` and `HH:MM:SS` and normalises to the latter, which is how Postgres renders a
 * `time` column back — so a value round-trips through the API unchanged instead of appearing to
 * change the moment it is saved.
 */
export const clockTime = (): z.ZodType<string, z.ZodTypeDef, unknown> =>
  z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/, 'must be a 24-hour time, e.g. 09:00')
    .transform((value) => (value.length === 5 ? `${value}:00` : value));

/** `employees.email` — the column's own regex, plus a length the column does not bound. */
export const email = (): z.ZodType<string, z.ZodTypeDef, unknown> =>
  z
    .string()
    .max(254, 'is longer than an email address can be')
    .transform((value) => value.trim())
    .refine((value) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value), 'must be an email address');

/**
 * An opaque keyset cursor. Its contents are this API's business, so the schema only bounds the
 * shape; `src/repositories/reporting.ts` owns the encoding and rejects a corrupt one.
 */
export const cursor = (): z.ZodString =>
  z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/, 'is not a cursor issued by this API');

/**
 * A page size supplied as a query-string integer.
 *
 * Every list endpoint has one and every one is capped. An unbounded page is how a reporting
 * query becomes an outage: the row count is a function of how long the deployment has been
 * running, so "no limit" means "gets slower every month until it times out".
 */
const pageSize = (max: number, fallback: number) =>
  z
    .string()
    .regex(/^\d{1,4}$/, 'must be a whole number')
    .transform(Number)
    .refine((value) => value >= 1 && value <= max, `must be between 1 and ${max}`)
    .default(String(fallback));

/** Longest range any endpoint will scan, matching the cap in `src/aggregation/zone.ts`. */
export const MAX_RANGE_DAYS = 400;

function daysBetween(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((toMs - fromMs) / 86_400_000);
}

/**
 * Applies the two rules every date range shares.
 *
 * The span cap is not cosmetic: `from`/`to` reach a `between` predicate on an indexed column,
 * and a request for the year 1900 to 2999 is a full scan of `timesheets` dressed up as a filter.
 *
 * Written as a `superRefine` callback rather than a generic wrapper so each schema keeps its own
 * concrete type — a helper that took and returned a schema would have to erase the field set,
 * and the field set is what `.strict()` is checking.
 */
function checkRange(value: { from: string; to: string }, ctx: z.RefinementCtx): void {
  if (value.from > value.to) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['from'],
      message: 'must not be later than `to`',
    });
    return;
  }
  if (daysBetween(value.from, value.to) > MAX_RANGE_DAYS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      message: `range must not exceed ${MAX_RANGE_DAYS} days`,
    });
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * The query string as a plain object.
 *
 * API Gateway can deliver a key with an `undefined` value, and `exactOptionalPropertyTypes`
 * means a present-but-undefined property is not the same as an absent one to Zod's `.optional()`
 * — so the undefined entries are dropped rather than passed through.
 */
export function queryObject(ctx: RequestContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(ctx.queryParameters)) {
    if (typeof value === 'string' && value !== '') out[key] = value;
  }
  return out;
}

/** Validates the query string, throwing the API's 400 with one detail per bad parameter. */
export function parseQuery<S extends z.ZodTypeAny>(schema: S, ctx: RequestContext): z.output<S> {
  const result = schema.safeParse(queryObject(ctx));
  if (result.success) return result.data as z.output<S>;
  throw errors.validation(issuesToDetails(result.error.issues));
}

// ---------------------------------------------------------------------------
// Read queries
// ---------------------------------------------------------------------------

export const overviewQuery = z
  .object({
    /** Defaults to today in the organisation's timezone, resolved by the handler. */
    date: localDate().optional(),
  })
  .strict();

export const timesheetRangeQuery = z
  .object({
    from: localDate(),
    to: localDate(),
    employee_id: uuid().optional(),
    limit: pageSize(2000, 500),
  })
  .strict()
  .superRefine(checkRange);

export const employeeTimesheetQuery = z
  .object({
    from: localDate(),
    to: localDate(),
    /**
     * Whether to include the per-app / per-site / per-category / per-project child totals.
     * Off for a week view that only draws stacked bars, on for a single day's detail — the
     * breakdown is four extra reads and a range of 400 days does not need them.
     */
    include_breakdown: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .strict()
  .superRefine(checkRange);

export const activityQuery = z
  .object({
    /** Required, so the scan is always bounded to one employee-day. */
    date: localDate(),
    cursor: cursor().optional(),
    limit: pageSize(500, 200),
  })
  .strict();

export const screenshotListQuery = z
  .object({
    date: localDate(),
    cursor: cursor().optional(),
    limit: pageSize(200, 60),
  })
  .strict();

export const auditLogQuery = z
  .object({
    from: localDate().optional(),
    to: localDate().optional(),
    action: trimmedBounded(80).optional(),
    employee_id: uuid().optional(),
    cursor: cursor().optional(),
    limit: pageSize(200, 50),
  })
  .strict()
  .refine((value) => value.from === undefined || value.to === undefined || value.from <= value.to, {
    path: ['from'],
    message: 'must not be later than `to`',
  });

/**
 * `GET /v1/reports/export`.
 *
 * `format` accepts only `csv`. PDF is rendered in the dashboard with `@react-pdf/renderer`
 * (docs/PLAN.md §4): the data is already in the browser, and a headless-Chrome-sized dependency
 * has no business in a Lambda that also serves the read API. Asking for it here gets a 400 that
 * says so, rather than a 501 that leaves the caller guessing whether it is coming.
 */
export const exportQuery = z
  .object({
    format: z
      .enum(['csv', 'pdf'])
      .default('csv')
      .refine(
        (value) => value === 'csv',
        'PDF export is rendered in the dashboard, not by the API. Request format=csv.',
      ),
    from: localDate(),
    to: localDate(),
    employee_id: uuid().optional(),
  })
  .strict()
  .superRefine(checkRange);

export const employeeListQuery = z
  .object({
    status: z.enum(['active', 'inactive', 'all']).default('active'),
  })
  .strict();

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

export const createEmployeeBody = z
  .object({
    full_name: trimmedBounded(200),
    email: email(),
    /** Payroll or HRIS identifier, so exports reconcile without name matching. */
    external_ref: trimmedBounded(200).nullable().optional(),
    /** Defaults to the organisation's timezone, applied by the handler. */
    timezone: timezone().optional(),
    status: z.enum(['active', 'inactive']).default('active'),
    hired_on: localDate().nullable().optional(),
  })
  .strict();

export const updateEmployeeBody = z
  .object({
    full_name: trimmedBounded(200).optional(),
    email: email().optional(),
    external_ref: trimmedBounded(200).nullable().optional(),
    timezone: timezone().optional(),
    status: z.enum(['active', 'inactive']).optional(),
    hired_on: localDate().nullable().optional(),
  })
  .strict()
  // An empty PATCH would bump `updated_at` and write an audit row describing no change.
  .refine((value) => Object.keys(value).length > 0, 'must change at least one field');

// ---------------------------------------------------------------------------
// Dashboard users
// ---------------------------------------------------------------------------

/**
 * `POST /v1/users` creates the `users` row only.
 *
 * The Cognito account is not created here, and cannot be: `admin-api`'s execution role holds no
 * `cognito-idp` permission (`infra/modules/lambda/main.tf`), and adding one would also need the
 * `cognito-idp` interface endpoint on the data-plane subnets. So the flow is: create the account
 * in the pool, then register it here with its `sub`. `users.cognito_sub` is `not null unique`,
 * which is why the field is required rather than filled in later — a row without it authorises
 * nobody, because the pre-token trigger matches on `sub`.
 */
export const createUserBody = z
  .object({
    cognito_sub: trimmedBounded(255),
    email: email(),
    role: z.enum(['owner', 'manager', 'employee']),
    employee_id: uuid().nullable().optional(),
    status: z.enum(['active', 'disabled']).default('active'),
  })
  .strict()
  // Mirrors `users_employee_role_chk`: the employee role grants access to exactly one
  // employee's data, so it is meaningless without naming that employee.
  .refine((value) => value.role !== 'employee' || (value.employee_id ?? null) !== null, {
    path: ['employee_id'],
    message: 'is required for the employee role',
  });

export const updateUserBody = z
  .object({
    role: z.enum(['owner', 'manager', 'employee']).optional(),
    employee_id: uuid().nullable().optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'must change at least one field');

// ---------------------------------------------------------------------------
// Projects and rules
// ---------------------------------------------------------------------------

export const createProjectBody = z
  .object({
    name: trimmedBounded(120),
    code: trimmedBounded(40).nullable().optional(),
    is_active: z.boolean().default(true),
  })
  .strict();

export const updateProjectBody = z
  .object({
    name: trimmedBounded(120).optional(),
    code: trimmedBounded(40).nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'must change at least one field');

/**
 * A project-matching rule.
 *
 * `title_regex` patterns are compiled here as well as bounded in length. The aggregation job
 * evaluates them once per event with a time budget, but a pattern that does not compile at all
 * would fail every night at 02:15 rather than at the moment somebody typed it — and the person
 * who typed it is the only one who can fix it.
 */
export const createProjectRuleBody = z
  .object({
    match_type: z.enum(['app_exe', 'url_host', 'title_contains', 'title_regex']),
    pattern: trimmedBounded(400),
    priority: z.number().int().min(0).max(10_000).default(100),
  })
  .strict()
  .refine(
    (value) => {
      if (value.match_type !== 'title_regex') return true;
      try {
        new RegExp(value.pattern);
        return true;
      } catch {
        return false;
      }
    },
    { path: ['pattern'], message: 'is not a valid regular expression' },
  );

// ---------------------------------------------------------------------------
// Monitoring configuration
// ---------------------------------------------------------------------------

/**
 * `PUT /v1/config` — a complete replacement, so every mutable field is required.
 *
 * PUT rather than PATCH on purpose. This is the row that decides what is collected from
 * employees' laptops; the settings screen shows every field with its privacy impact stated and
 * a diff-confirm dialog before saving (docs/PLAN.md §7). A partial update would mean the caller
 * can change screenshot capture without ever seeing, or restating, the exclusion list it ships
 * alongside — and "I didn't realise that was still on" is not an acceptable outcome here.
 *
 * Every bound below is the CHECK constraint from `monitoring_config`.
 */
export const updateConfigBody = z
  .object({
    sample_interval_seconds: z.number().int().min(15).max(900),
    idle_threshold_seconds: z.number().int().min(60).max(3600),

    capture_window_titles: z.boolean(),
    capture_urls: z.boolean(),
    screenshot_enabled: z.boolean(),
    screenshot_interval_seconds: z.number().int().min(60).max(7200),
    screenshot_blur: z.boolean(),

    work_hours_only: z.boolean(),
    work_hours_start: clockTime(),
    work_hours_end: clockTime(),
    /** ISO-8601 weekdays: 1 = Monday … 7 = Sunday, matching `extract(isodow from …)`. */
    work_days: z.array(z.number().int().min(1).max(7)).min(1).max(7),

    excluded_apps: z.array(trimmedBounded(400)).max(200),
    excluded_url_patterns: z.array(trimmedBounded(400)).max(200),

    retention_days_events: z.number().int().min(1).max(3650),
    retention_days_screenshots: z.number().int().min(1).max(3650),
  })
  .strict()
  // `monitoring_config_work_hours_chk`: equal start and end is rejected rather than meaning
  // "all day", because an all-day window is expressed by work_hours_only = false.
  .refine((value) => value.work_hours_start !== value.work_hours_end, {
    path: ['work_hours_end'],
    message: 'must differ from work_hours_start; for an all-day window set work_hours_only=false',
  })
  // `monitoring_config_work_days_chk` also requires the values be distinct in effect.
  .refine((value) => new Set(value.work_days).size === value.work_days.length, {
    path: ['work_days'],
    message: 'must not repeat a weekday',
  })
  // `monitoring_config_retention_chk`: keeping images longer than the activity that explains
  // them serves no legitimate purpose.
  .refine((value) => value.retention_days_screenshots <= value.retention_days_events, {
    path: ['retention_days_screenshots'],
    message: 'must not exceed retention_days_events',
  });

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export const createEnrollmentTokenBody = z
  .object({
    employee_id: uuid(),
    /**
     * Capped at a week. An enrolment token is a bearer credential that mints device
     * credentials, so its lifetime is the window in which a leaked one is useful.
     */
    expires_in_hours: z.number().int().min(1).max(168).default(24),
  })
  .strict();

// ---------------------------------------------------------------------------
// Data deletion
// ---------------------------------------------------------------------------

export const createDeletionRequestBody = z
  .object({
    employee_id: uuid(),
    scope: z.enum(['all', 'screenshots', 'events']),
    /** Recorded on the request row; this is the paper trail for an erasure. */
    reason: trimmedBounded(2000).optional(),
  })
  .strict();

export type CreateEmployeeBody = z.output<typeof createEmployeeBody>;
export type UpdateEmployeeBody = z.output<typeof updateEmployeeBody>;
export type CreateUserBody = z.output<typeof createUserBody>;
export type UpdateUserBody = z.output<typeof updateUserBody>;
export type CreateProjectBody = z.output<typeof createProjectBody>;
export type UpdateProjectBody = z.output<typeof updateProjectBody>;
export type CreateProjectRuleBody = z.output<typeof createProjectRuleBody>;
export type UpdateConfigBody = z.output<typeof updateConfigBody>;
export type CreateEnrollmentTokenBody = z.output<typeof createEnrollmentTokenBody>;
export type CreateDeletionRequestBody = z.output<typeof createDeletionRequestBody>;
