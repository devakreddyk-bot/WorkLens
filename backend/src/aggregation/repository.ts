/**
 * Database access for the aggregation job.
 *
 * Kept beside the rollup rather than in `src/repositories/` because these queries exist only to feed
 * it: they are shaped by what `rollup.ts` needs, not by what a dashboard reads. The dashboard's read
 * queries live in `src/repositories/reporting.ts` and go against the aggregate tables this job
 * writes.
 */

import { query, transaction } from '../shared/db.js';
import type { Tx } from '../repositories/executor.js';
import type { CategoryRule, DailyRollup, ProjectRule, RollupEvent } from './rollup.js';
import type { LocalDate } from './zone.js';

/** An employee the job may need to aggregate. */
export interface AggregationTarget {
  employeeId: string;
  timezone: string;
  status: 'active' | 'inactive';
}

/**
 * Lists the employees to aggregate.
 *
 * Inactive employees are included deliberately. Somebody who left last week still has events from
 * their final days that have to reach a timesheet, and excluding them would silently lose the last
 * week of a departing employee's record — which is exactly when it matters for a final pay run.
 */
export async function listAggregationTargets(
  orgId: string,
  employeeId?: string,
): Promise<AggregationTarget[]> {
  const result = await query<{ id: string; timezone: string; status: 'active' | 'inactive' }>({
    name: 'aggregation-targets',
    text: `select id, timezone, status
             from employees
            where org_id = $1
              and ($2::uuid is null or id = $2::uuid)
            order by id`,
    values: [orgId, employeeId ?? null],
  });

  return result.rows.map((row) => ({
    employeeId: row.id,
    timezone: row.timezone,
    status: row.status,
  }));
}

/**
 * Fetches the events for one employee over a UTC window.
 *
 * Ordered by `captured_at` so the rollup sees them chronologically, which is not required by the
 * arithmetic but makes a log of the run readable when something looks wrong.
 */
export async function fetchEvents(
  orgId: string,
  employeeId: string,
  fromInclusive: Date,
  toExclusive: Date,
  limit: number,
): Promise<{ events: RollupEvent[]; truncated: boolean }> {
  const result = await query<{
    captured_at: Date;
    duration_seconds: number;
    is_idle: boolean;
    event_type: string;
    app_name: string | null;
    app_exe: string | null;
    window_title: string | null;
    url_host: string | null;
  }>({
    name: 'aggregation-fetch-events',
    text: `select captured_at, duration_seconds, is_idle, event_type,
                  app_name, app_exe, window_title, url_host
             from activity_events
            where org_id = $1
              and employee_id = $2
              and captured_at >= $3
              and captured_at < $4
            order by captured_at
            limit $5`,
    values: [orgId, employeeId, fromInclusive, toExclusive, limit + 1],
  });

  // Fetching limit+1 is how truncation is detected without a second count query. A truncated window
  // would silently understate a timesheet, so the caller must be able to report it rather than
  // writing a plausible-looking wrong number.
  const truncated = result.rows.length > limit;
  const rows = truncated ? result.rows.slice(0, limit) : result.rows;

  return {
    truncated,
    events: rows.map((row) => ({
      capturedAt: row.captured_at,
      durationSeconds: row.duration_seconds,
      isIdle: row.is_idle,
      eventType: row.event_type,
      appName: row.app_name,
      appExe: row.app_exe,
      windowTitle: row.window_title,
      urlHost: row.url_host,
    })),
  };
}

/** Loads the org's category rules. */
export async function fetchCategoryRules(orgId: string): Promise<CategoryRule[]> {
  const result = await query<{
    id: string;
    match_type: 'app_exe' | 'url_host';
    pattern: string;
    category: string;
    priority: number;
    created_at: Date;
  }>({
    name: 'aggregation-category-rules',
    text: `select id, match_type, pattern, category, priority, created_at
             from app_categories
            where org_id = $1
            order by priority, created_at, id`,
    values: [orgId],
  });

  return result.rows.map((row) => ({
    id: row.id,
    matchType: row.match_type,
    pattern: row.pattern,
    category: row.category,
    priority: row.priority,
    createdAt: row.created_at,
  }));
}

/**
 * Loads the org's project rules.
 *
 * Only rules belonging to active projects. A rule on a deactivated project would keep attributing
 * time to it, and the dashboard would show hours accruing against a project somebody had closed.
 */
export async function fetchProjectRules(orgId: string): Promise<ProjectRule[]> {
  const result = await query<{
    id: string;
    project_id: string;
    match_type: 'app_exe' | 'url_host' | 'title_contains' | 'title_regex';
    pattern: string;
    priority: number;
    created_at: Date;
  }>({
    name: 'aggregation-project-rules',
    text: `select r.id, r.project_id, r.match_type, r.pattern, r.priority, r.created_at
             from project_rules r
             join projects p on p.id = r.project_id
            where r.org_id = $1
              and p.is_active
            order by r.priority, r.created_at, r.id`,
    values: [orgId],
  });

  return result.rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    matchType: row.match_type,
    pattern: row.pattern,
    priority: row.priority,
    createdAt: row.created_at,
  }));
}

/**
 * Counts uploaded screenshots per local day for one employee.
 *
 * Counted in the database rather than by fetching rows, and only `uploaded` ones: a presign that was
 * never completed is not a screenshot anybody can look at, so counting it would overstate what the
 * dashboard can actually show.
 *
 * The day bucketing uses Postgres's `at time zone`, which applies the same IANA rules as the
 * TypeScript side. Two implementations of the same conversion is a drift risk, but the alternative —
 * fetching every screenshot row to bucket in application code — costs a row per screenshot per run
 * for a number that is only ever displayed.
 */
export async function fetchScreenshotCounts(
  orgId: string,
  employeeId: string,
  timezone: string,
  fromInclusive: Date,
  toExclusive: Date,
): Promise<Map<LocalDate, number>> {
  const result = await query<{ work_date: string; count: string }>({
    name: 'aggregation-screenshot-counts',
    text: `select to_char((captured_at at time zone $3)::date, 'YYYY-MM-DD') as work_date,
                  count(*)::text as count
             from screenshots
            where org_id = $1
              and employee_id = $2
              and upload_state = 'uploaded'
              and captured_at >= $4
              and captured_at < $5
            group by 1`,
    values: [orgId, employeeId, timezone, fromInclusive, toExclusive],
  });

  return new Map(result.rows.map((row) => [row.work_date, Number(row.count)]));
}

/**
 * Writes one day's rollup, replacing whatever was there.
 *
 * Idempotent by construction: the upsert keys on `(org_id, employee_id, work_date)` and the child
 * totals are deleted and rewritten inside the same transaction. Recomputing a settled day is
 * therefore free, which is what makes a generous lookback window safe — and the lookback exists
 * because an agent offline overnight uploads yesterday's events today.
 *
 * `version` increments on every write, so a dashboard holding a stale read can tell.
 */
export async function upsertTimesheet(
  orgId: string,
  employeeId: string,
  rollup: DailyRollup,
): Promise<{ timesheetId: string; version: number }> {
  return transaction(async (tx) => {
    const upserted = await tx.query<{ id: string; version: number }>({
      text: `insert into timesheets (
                 org_id, employee_id, work_date, timezone,
                 active_seconds, idle_seconds, total_seconds,
                 first_activity_at, last_activity_at,
                 screenshot_count, source_event_count, version, computed_at
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, now())
             on conflict (org_id, employee_id, work_date) do update set
                 timezone           = excluded.timezone,
                 active_seconds     = excluded.active_seconds,
                 idle_seconds       = excluded.idle_seconds,
                 total_seconds      = excluded.total_seconds,
                 first_activity_at  = excluded.first_activity_at,
                 last_activity_at   = excluded.last_activity_at,
                 screenshot_count   = excluded.screenshot_count,
                 source_event_count = excluded.source_event_count,
                 version            = timesheets.version + 1,
                 computed_at        = now()
             returning id, version`,
      values: [
        orgId,
        employeeId,
        rollup.workDate,
        rollup.timezone,
        rollup.activeSeconds,
        rollup.idleSeconds,
        rollup.totalSeconds,
        rollup.firstActivityAt,
        rollup.lastActivityAt,
        rollup.screenshotCount,
        rollup.sourceEventCount,
      ],
    });

    const row = upserted.rows[0];
    if (row === undefined) {
      throw new Error('aggregation: the timesheet upsert returned no row');
    }

    await replaceTotals(tx, row.id, rollup);

    return { timesheetId: row.id, version: row.version };
  });
}

/**
 * Rewrites the four child total tables.
 *
 * Delete-then-insert rather than a per-key upsert, because a recomputation can *remove* a bucket —
 * an app the employee no longer used, or a project whose rule was deleted. An upsert-only approach
 * would leave those rows behind and the dashboard would keep showing time against them forever.
 */
async function replaceTotals(tx: Tx, timesheetId: string, rollup: DailyRollup): Promise<void> {
  const tables = [
    { table: 'timesheet_app_totals', column: 'app_name', buckets: rollup.apps },
    { table: 'timesheet_site_totals', column: 'url_host', buckets: rollup.sites },
    { table: 'timesheet_category_totals', column: 'category', buckets: rollup.categories },
    { table: 'timesheet_project_totals', column: 'project_id', buckets: rollup.projects },
  ] as const;

  for (const { table, column, buckets } of tables) {
    // The table and column names come from the constant above, never from input. Every value is
    // still parameterised.
    await tx.query({
      text: `delete from ${table} where timesheet_id = $1`,
      values: [timesheetId],
    });

    const keys = Object.keys(buckets).filter((key) => (buckets[key] ?? 0) > 0);
    if (keys.length === 0) continue;

    const seconds = keys.map((key) => buckets[key] ?? 0);

    // One multi-row insert via unnest rather than a statement per bucket: a busy day can have
    // dozens of apps, and a round trip each would dominate the job's runtime.
    await tx.query({
      text: `insert into ${table} (timesheet_id, ${column}, seconds)
             select $1, key, value
               from unnest($2::text[], $3::int[]) as t(key, value)`,
      values: [timesheetId, keys, seconds],
    });
  }
}

/**
 * Deletes a timesheet and its totals for a day that turned out to have no events.
 *
 * Needed because a recomputation can legitimately find nothing — a deletion request erased the
 * events, or an agent's batch was rejected and retried into a different day. Leaving the old row
 * would show hours for a day that has no evidence behind it.
 */
export async function deleteTimesheet(
  orgId: string,
  employeeId: string,
  workDate: LocalDate,
): Promise<boolean> {
  const result = await query({
    name: 'aggregation-delete-timesheet',
    // The child tables cascade from timesheets.
    text: `delete from timesheets
            where org_id = $1 and employee_id = $2 and work_date = $3`,
    values: [orgId, employeeId, workDate],
  });
  return (result.rowCount ?? 0) > 0;
}

/** Lists every organisation, for a scheduled run that was given no org. */
export async function listOrganizationIds(): Promise<string[]> {
  const result = await query<{ id: string }>({
    name: 'aggregation-list-orgs',
    text: 'select id from organizations order by id',
  });
  return result.rows.map((row) => row.id);
}
