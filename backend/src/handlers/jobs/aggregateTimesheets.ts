/**
 * Rolls raw activity into daily timesheets. Scheduled nightly, and invocable on demand.
 *
 * Two callers, one entry point:
 *
 *   EventBridge  {"source":"schedule","lookback_days":3}
 *   The API      POST /v1/aggregation/run, which invokes this with an org and optionally an
 *                employee or an explicit date range
 *
 * The scheduled path aggregates every organisation. That is not over-engineering for a
 * single-company deployment: the schema is multi-tenant throughout, and a job that silently only
 * handled the first org would be the kind of thing nobody notices until there is a second one.
 */

import { logger } from '../../shared/logger.js';
import { run } from '../../aggregation/runner.js';
import type { RunResult } from '../../aggregation/runner.js';
import { listOrganizationIds } from '../../aggregation/repository.js';
import { config } from '../../shared/config.js';

export interface AggregateEvent {
  source?: string;
  /** Restrict to one organisation. Omitted means every organisation. */
  org_id?: string;
  /** Restrict to one employee. Requires org_id. */
  employee_id?: string;
  /** Explicit local date range, YYYY-MM-DD. Overrides lookback_days. */
  from?: string;
  to?: string;
  lookback_days?: number;
}

export interface AggregateResponse {
  ok: boolean;
  organisations: number;
  employeesProcessed: number;
  employeesFailed: number;
  daysWritten: number;
  daysDeleted: number;
  eventsRead: number;
  implausibleDays: number;
  truncatedEmployees: number;
  durationMs: number;
  results: RunResult[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function handler(event: AggregateEvent = {}): Promise<AggregateResponse> {
  const started = Date.now();

  if (event.from !== undefined && !DATE_RE.test(event.from)) {
    throw new Error(`aggregate: from must be YYYY-MM-DD, got ${JSON.stringify(event.from)}`);
  }
  if (event.to !== undefined && !DATE_RE.test(event.to)) {
    throw new Error(`aggregate: to must be YYYY-MM-DD, got ${JSON.stringify(event.to)}`);
  }
  if (event.employee_id !== undefined && event.org_id === undefined) {
    // Without an org the employee id would have to be looked up across every tenant, which is
    // exactly the cross-tenant query the schema is arranged to prevent.
    throw new Error('aggregate: employee_id requires org_id');
  }

  const lookbackDays = event.lookback_days ?? config.AGGREGATION_LOOKBACK_DAYS;
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 31) {
    throw new Error(`aggregate: lookback_days must be 1-31, got ${String(event.lookback_days)}`);
  }

  const orgIds = event.org_id !== undefined ? [event.org_id] : await listOrganizationIds();

  const log = logger.child({ handler: 'aggregate-timesheets', source: event.source ?? 'manual' });
  log.info('starting', { organisations: orgIds.length, lookbackDays, from: event.from, to: event.to });

  const results: RunResult[] = [];
  for (const orgId of orgIds) {
    // Sequentially, deliberately. The functions run with a pool of one connection (see
    // shared/db.ts), so concurrent organisations would queue on the same connection anyway while
    // making the log interleaved and the failure attribution harder.
    results.push(
      await run({
        orgId,
        lookbackDays,
        log,
        ...(event.employee_id === undefined ? {} : { employeeId: event.employee_id }),
        ...(event.from === undefined ? {} : { from: event.from }),
        ...(event.to === undefined ? {} : { to: event.to }),
      }),
    );
  }

  const response: AggregateResponse = {
    ok: true,
    organisations: orgIds.length,
    employeesProcessed: sum(results, (r) => r.employeesProcessed),
    employeesFailed: sum(results, (r) => r.employeesFailed),
    daysWritten: sum(results, (r) => r.daysWritten),
    daysDeleted: sum(results, (r) => r.daysDeleted),
    eventsRead: sum(results, (r) => r.eventsRead),
    implausibleDays: sum(results, (r) =>
      r.outcomes.reduce((total, o) => total + o.implausibleDays.length, 0),
    ),
    truncatedEmployees: sum(results, (r) => r.outcomes.filter((o) => o.truncated).length),
    durationMs: Date.now() - started,
    results,
  };

  // A per-employee failure does not fail the invocation — the other employees' timesheets were
  // written and a retry would repeat the same failure. It is surfaced in the response and logged at
  // error, which is what the CloudWatch alarm watches.
  if (response.employeesFailed > 0) {
    log.error('some employees could not be aggregated', {
      failed: response.employeesFailed,
      processed: response.employeesProcessed,
    });
  }

  log.info('finished', {
    daysWritten: response.daysWritten,
    daysDeleted: response.daysDeleted,
    eventsRead: response.eventsRead,
    durationMs: response.durationMs,
  });

  return response;
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}
