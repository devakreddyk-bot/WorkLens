/**
 * The I/O half of aggregation: fetch, roll up, write.
 *
 * All the arithmetic lives in `rollup.ts` and all the timezone reasoning in `zone.ts`, both pure.
 * This module's job is to decide *what* to aggregate, load it, and store the result — and to do so
 * such that running it twice over the same window produces the same answer.
 *
 * # Why the window is wider than it looks
 *
 * Two separate widenings, for two different reasons, and both are easy to omit:
 *
 *  1. **A lookback of several days, not one.** An agent offline overnight uploads yesterday's events
 *     today. Aggregating only yesterday would leave those events sitting in the database, correctly
 *     stored and permanently absent from any timesheet. The default is three days.
 *
 *  2. **An hour of slack before the window's start instant.** An event is stored by the moment it
 *     *began*, and may last up to an hour. A sample starting at 23:50 the day before the window
 *     contributes ten minutes to the window's first day, and a query bounded exactly at the day
 *     boundary would miss it — understating every first day by up to an hour.
 */

import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import type { Logger } from '../shared/logger.js';
import { aggregate, implausible } from './rollup.js';
import type { DailyRollup } from './rollup.js';
import {
  deleteTimesheet,
  fetchCategoryRules,
  fetchEvents,
  fetchProjectRules,
  fetchScreenshotCounts,
  listAggregationTargets,
  upsertTimesheet,
} from './repository.js';
import type { AggregationTarget } from './repository.js';
import {
  addLocalDays,
  isValidTimeZone,
  localDateOf,
  localDateRange,
  localDayLengthSeconds,
  startOfLocalDay,
  startOfNextLocalDay,
} from './zone.js';
import type { LocalDate } from './zone.js';

/**
 * An event may last an hour, and is indexed by when it started. See the note on widening above.
 * Kept slightly over the hour so a boundary event cannot be lost to rounding.
 */
const EVENT_LOOKBEHIND_MS = 61 * 60 * 1000;

/**
 * Ceiling on events loaded for one employee-window.
 *
 * At a 60-second sample interval with coalescing, a busy fortnight is a few thousand events, so this
 * is far above any legitimate volume. It exists so a runaway agent cannot make the job load an
 * unbounded result set into a 1 GB Lambda — and `fetchEvents` reports truncation rather than
 * silently understating a timesheet.
 */
const MAX_EVENTS_PER_EMPLOYEE = 250_000;

export interface RunRequest {
  orgId: string;
  /** Aggregate a single employee. Omitted means every employee in the org. */
  employeeId?: string;
  /** Explicit local date range. Omitted uses the lookback window. */
  from?: LocalDate;
  to?: LocalDate;
  /** How many days back to recompute when no explicit range is given. */
  lookbackDays?: number;
  /** Injected for tests. */
  now?: Date;
  log?: Logger;
}

export interface EmployeeOutcome {
  employeeId: string;
  timezone: string;
  daysWritten: number;
  daysDeleted: number;
  eventsRead: number;
  /** Days whose rollup failed the plausibility check. Written anyway; see below. */
  implausibleDays: string[];
  /** True when the event window hit MAX_EVENTS_PER_EMPLOYEE. */
  truncated: boolean;
  error?: string;
}

export interface RunResult {
  orgId: string;
  from: LocalDate;
  to: LocalDate;
  employeesProcessed: number
  employeesFailed: number;
  daysWritten: number;
  daysDeleted: number;
  eventsRead: number;
  outcomes: EmployeeOutcome[];
  durationMs: number;
}

/**
 * Aggregates an organisation.
 *
 * One employee's failure does not stop the others. That is deliberate: a single employee with a
 * corrupt timezone or an unreadable event should not cost the whole organisation its nightly
 * timesheets, and the alternative — failing the run — means the EventBridge retry does the same
 * work and fails the same way.
 */
export async function run(request: RunRequest): Promise<RunResult> {
  const started = Date.now();
  const log = request.log ?? logger;
  const now = request.now ?? new Date();

  const targets = await listAggregationTargets(request.orgId, request.employeeId);

  const [categoryRules, projectRules] = await Promise.all([
    fetchCategoryRules(request.orgId),
    fetchProjectRules(request.orgId),
  ]);

  const outcomes: EmployeeOutcome[] = [];
  let rangeFrom: LocalDate | undefined = request.from;
  let rangeTo: LocalDate | undefined = request.to;

  for (const target of targets) {
    const outcome = await aggregateEmployee({
      orgId: request.orgId,
      target,
      from: request.from,
      to: request.to,
      lookbackDays: request.lookbackDays ?? config.AGGREGATION_LOOKBACK_DAYS,
      now,
      categoryRules,
      projectRules,
      log,
    });

    outcomes.push(outcome.outcome);
    // Recorded for the summary. Each employee's range is computed in their own timezone, so two
    // employees on the same run can legitimately cover different calendar dates.
    rangeFrom ??= outcome.from;
    rangeTo ??= outcome.to;
  }

  const result: RunResult = {
    orgId: request.orgId,
    from: rangeFrom ?? localDateOf(now, 'UTC'),
    to: rangeTo ?? localDateOf(now, 'UTC'),
    employeesProcessed: outcomes.filter((o) => o.error === undefined).length,
    employeesFailed: outcomes.filter((o) => o.error !== undefined).length,
    daysWritten: outcomes.reduce((total, o) => total + o.daysWritten, 0),
    daysDeleted: outcomes.reduce((total, o) => total + o.daysDeleted, 0),
    eventsRead: outcomes.reduce((total, o) => total + o.eventsRead, 0),
    outcomes,
    durationMs: Date.now() - started,
  };

  log.info('aggregation run complete', {
    orgId: result.orgId,
    from: result.from,
    to: result.to,
    employeesProcessed: result.employeesProcessed,
    employeesFailed: result.employeesFailed,
    daysWritten: result.daysWritten,
    daysDeleted: result.daysDeleted,
    eventsRead: result.eventsRead,
    durationMs: result.durationMs,
  });

  return result;
}

interface EmployeeRequest {
  orgId: string;
  target: AggregationTarget;
  // Explicitly `| undefined` rather than optional: with exactOptionalPropertyTypes, an optional
  // property cannot be assigned an explicit undefined, and the caller forwards request.from
  // directly whether or not it was supplied.
  from: LocalDate | undefined;
  to: LocalDate | undefined;
  lookbackDays: number;
  now: Date;
  categoryRules: Awaited<ReturnType<typeof fetchCategoryRules>>;
  projectRules: Awaited<ReturnType<typeof fetchProjectRules>>;
  log: Logger;
}

async function aggregateEmployee(
  request: EmployeeRequest,
): Promise<{ outcome: EmployeeOutcome; from: LocalDate; to: LocalDate }> {
  const { orgId, target, log } = request;

  const outcome: EmployeeOutcome = {
    employeeId: target.employeeId,
    timezone: target.timezone,
    daysWritten: 0,
    daysDeleted: 0,
    eventsRead: 0,
    implausibleDays: [],
    truncated: false,
  };

  // A bad timezone is caught here so the message names the employee. Falling back to UTC instead
  // would quietly produce timesheets cut on the wrong boundary — plausible-looking and wrong, which
  // is worse than a reported failure.
  if (!isValidTimeZone(target.timezone)) {
    outcome.error = `employee ${target.employeeId} has an unusable timezone ${JSON.stringify(target.timezone)}`;
    log.error('skipping an employee with an invalid timezone', {
      employeeId: target.employeeId,
      timezone: target.timezone,
    });
    const fallback = localDateOf(request.now, 'UTC');
    return { outcome, from: fallback, to: fallback };
  }

  const today = localDateOf(request.now, target.timezone);
  const to = request.to ?? today;
  const from = request.from ?? addLocalDays(to, -(request.lookbackDays - 1));

  try {
    const windowStart = new Date(startOfLocalDay(from, target.timezone).getTime() - EVENT_LOOKBEHIND_MS);
    const windowEnd = startOfNextLocalDay(to, target.timezone);

    const [{ events, truncated }, screenshotCounts] = await Promise.all([
      fetchEvents(orgId, target.employeeId, windowStart, windowEnd, MAX_EVENTS_PER_EMPLOYEE),
      fetchScreenshotCounts(orgId, target.employeeId, target.timezone, windowStart, windowEnd),
    ]);

    outcome.eventsRead = events.length;
    outcome.truncated = truncated;

    if (truncated) {
      // Reported loudly. A truncated window understates a timesheet, and a quietly wrong timesheet
      // is the failure mode this whole module is arranged to avoid.
      log.error('event window truncated; the resulting timesheets understate this employee', {
        employeeId: target.employeeId,
        limit: MAX_EVENTS_PER_EMPLOYEE,
        from,
        to,
      });
    }

    const { rollups, warnings } = aggregate(events, {
      timezone: target.timezone,
      categoryRules: request.categoryRules,
      projectRules: request.projectRules,
      screenshotCounts,
      regexBudgetMs: config.AGGREGATION_REGEX_BUDGET_MS,
    });

    if (warnings.disabledRegexRules.length > 0) {
      log.warn('project rules disabled during aggregation', {
        employeeId: target.employeeId,
        ruleIds: warnings.disabledRegexRules,
      });
    }
    if (warnings.skippedEvents > 0 || warnings.clampedEvents > 0) {
      log.warn('some events needed correcting', {
        employeeId: target.employeeId,
        skipped: warnings.skippedEvents,
        clamped: warnings.clampedEvents,
      });
    }

    // Only days inside the requested range are written. The lookbehind can produce a rollup for the
    // day *before* the window — from an event that began at 23:50 and spilled in — and writing that
    // would replace a settled day using only its final ten minutes.
    const requested = new Set(localDateRange(from, to));
    const byDate = new Map<LocalDate, DailyRollup>();
    for (const rollup of rollups) {
      if (requested.has(rollup.workDate)) {
        byDate.set(rollup.workDate, rollup);
      }
    }

    for (const workDate of requested) {
      const rollup = byDate.get(workDate);

      if (rollup === undefined) {
        // No events for this day. A previously written timesheet is removed rather than left behind:
        // a deletion request may have erased the events, and hours with no evidence behind them
        // must not survive on a dashboard.
        if (await deleteTimesheet(orgId, target.employeeId, workDate)) {
          outcome.daysDeleted += 1;
          log.info('removed a timesheet for a day that now has no events', {
            employeeId: target.employeeId,
            workDate,
          });
        }
        continue;
      }

      const problem = implausible(rollup, localDayLengthSeconds(workDate, target.timezone));
      if (problem !== null) {
        // Written anyway, and reported. A too-large timesheet somebody can investigate is more
        // useful than a missing one nobody can explain.
        outcome.implausibleDays.push(workDate);
        log.error('implausible rollup written for investigation', {
          employeeId: target.employeeId,
          workDate,
          problem,
        });
      }

      await upsertTimesheet(orgId, target.employeeId, rollup);
      outcome.daysWritten += 1;
    }
  } catch (err) {
    outcome.error = err instanceof Error ? err.message : String(err);
    log.error('aggregation failed for one employee; continuing with the rest', {
      employeeId: target.employeeId,
      err,
    });
  }

  return { outcome, from, to };
}
