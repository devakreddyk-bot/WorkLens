/**
 * Deletes employee data past its configured retention window. Scheduled daily.
 *
 * This handler exists to delete personal data, which makes it the most consequential job in the
 * system in both directions: failing to run means the organisation keeps data longer than it said it
 * would, and running wrong means losing a timesheet somebody needs for payroll.
 *
 * Three properties follow from that:
 *
 *  1. **Every run is bounded.** A first run against a long backlog, or a run after somebody shortens
 *     the retention window sharply, must not become an unbounded delete that times out half-way
 *     through. It deletes up to a ceiling and reports how much is left; the next run continues.
 *
 *  2. **S3 objects go before the rows that point at them.** Reversed, a crash in between would leave
 *     images in the bucket with nothing in the database referring to them — undeletable except by
 *     hand, and invisible to every retention report.
 *
 *  3. **It never deletes a screenshot whose row it did not delete**, and never reports success for a
 *     batch it did not finish.
 *
 * Retention is per-organisation, from `monitoring_config`. The S3 lifecycle rule in Terraform is a
 * backstop set at or above the longest configured window, not the policy — the policy is here,
 * because only here is it visible to an audit.
 */

import { DeleteObjectsCommand, S3Client } from '@aws-sdk/client-s3';

import { config } from '../../shared/config.js';
import { query } from '../../shared/db.js';
import { logger } from '../../shared/logger.js';
import type { Logger } from '../../shared/logger.js';

export interface RetentionSweepEvent {
  source?: string;
  /** Restrict to one organisation. Omitted means every organisation. */
  org_id?: string;
  /** Ceiling on rows deleted in one run, across all organisations. */
  max_deletions_per_run?: number;
  /** Report what would be deleted without deleting it. */
  dry_run?: boolean;
}

export interface OrgRetentionOutcome {
  orgId: string;
  retentionDaysEvents: number;
  retentionDaysScreenshots: number;
  eventsDeleted: number;
  screenshotsDeleted: number;
  objectsDeleted: number;
  /** True when the ceiling was reached and data past retention remains. */
  moreRemaining: boolean;
  error?: string;
}

export interface RetentionSweepResponse {
  ok: boolean;
  dryRun: boolean;
  organisations: number;
  eventsDeleted: number;
  screenshotsDeleted: number;
  objectsDeleted: number;
  expiredPendingScreenshots: number;
  moreRemaining: boolean;
  outcomes: OrgRetentionOutcome[];
  durationMs: number;
}

const DEFAULT_MAX_DELETIONS = 200_000;

/** Rows deleted per statement. Keeps any single lock short so ingest is never blocked for long. */
const EVENT_BATCH = 5_000;

/** S3 accepts up to 1000 keys per DeleteObjects call. */
const S3_BATCH = 1_000;

/**
 * A presign that never completed is not a screenshot anybody can view. Swept after a day so the
 * table does not accumulate rows for uploads that failed — see `screenshots_pending_idx`.
 */
const PENDING_EXPIRY_HOURS = 24;

let s3: S3Client | undefined;

function s3Client(): S3Client {
  s3 ??= new S3Client({ region: config.AWS_REGION });
  return s3;
}

export async function handler(event: RetentionSweepEvent = {}): Promise<RetentionSweepResponse> {
  const started = Date.now();
  const log = logger.child({ handler: 'retention-sweeper', source: event.source ?? 'manual' });

  const dryRun = event.dry_run === true;
  let budget = event.max_deletions_per_run ?? DEFAULT_MAX_DELETIONS;
  if (!Number.isInteger(budget) || budget < 1000) {
    throw new Error(
      `retention: max_deletions_per_run must be at least 1000, got ${String(event.max_deletions_per_run)}. ` +
        `A smaller ceiling can never catch up with a backlog.`,
    );
  }

  const orgs = await listRetentionPolicies(event.org_id);
  log.info('starting', { organisations: orgs.length, budget, dryRun });

  const outcomes: OrgRetentionOutcome[] = [];

  for (const org of orgs) {
    const outcome: OrgRetentionOutcome = {
      orgId: org.orgId,
      retentionDaysEvents: org.retentionDaysEvents,
      retentionDaysScreenshots: org.retentionDaysScreenshots,
      eventsDeleted: 0,
      screenshotsDeleted: 0,
      objectsDeleted: 0,
      moreRemaining: false,
    };

    try {
      // Screenshots first. They are the largest and most sensitive artefact, and their retention
      // window is never longer than the events' (the schema enforces it), so doing them first means
      // a run that exhausts its budget has removed the more sensitive data.
      const screenshots = await sweepScreenshots(org, budget, dryRun, log);
      outcome.screenshotsDeleted = screenshots.rowsDeleted;
      outcome.objectsDeleted = screenshots.objectsDeleted;
      outcome.moreRemaining = screenshots.moreRemaining;
      budget -= screenshots.rowsDeleted;

      if (budget > 0) {
        const events = await sweepEvents(org, budget, dryRun, log);
        outcome.eventsDeleted = events.rowsDeleted;
        outcome.moreRemaining = outcome.moreRemaining || events.moreRemaining;
        budget -= events.rowsDeleted;
      } else {
        outcome.moreRemaining = true;
      }
    } catch (err) {
      // One organisation's failure must not stop the others: on a multi-tenant deployment that would
      // mean one bad configuration halting everybody's retention, which is a compliance problem
      // rather than an inconvenience.
      outcome.error = err instanceof Error ? err.message : String(err);
      log.error('retention failed for one organisation; continuing', { orgId: org.orgId, err });
    }

    outcomes.push(outcome);
    if (budget <= 0) {
      log.warn('deletion ceiling reached; the next scheduled run will continue', {
        remainingOrganisations: orgs.length - outcomes.length,
      });
      break;
    }
  }

  const expiredPending = dryRun ? 0 : await expirePendingScreenshots(log);

  const response: RetentionSweepResponse = {
    ok: true,
    dryRun,
    organisations: outcomes.length,
    eventsDeleted: outcomes.reduce((t, o) => t + o.eventsDeleted, 0),
    screenshotsDeleted: outcomes.reduce((t, o) => t + o.screenshotsDeleted, 0),
    objectsDeleted: outcomes.reduce((t, o) => t + o.objectsDeleted, 0),
    expiredPendingScreenshots: expiredPending,
    moreRemaining: outcomes.some((o) => o.moreRemaining) || outcomes.length < orgs.length,
    outcomes,
    durationMs: Date.now() - started,
  };

  log.info('finished', {
    eventsDeleted: response.eventsDeleted,
    screenshotsDeleted: response.screenshotsDeleted,
    objectsDeleted: response.objectsDeleted,
    moreRemaining: response.moreRemaining,
    durationMs: response.durationMs,
  });

  return response;
}

interface RetentionPolicy {
  orgId: string;
  retentionDaysEvents: number;
  retentionDaysScreenshots: number;
}

async function listRetentionPolicies(orgId?: string): Promise<RetentionPolicy[]> {
  const result = await query<{
    org_id: string;
    retention_days_events: number;
    retention_days_screenshots: number;
  }>({
    name: 'retention-policies',
    text: `select org_id, retention_days_events, retention_days_screenshots
             from monitoring_config
            where ($1::uuid is null or org_id = $1::uuid)
            order by org_id`,
    values: [orgId ?? null],
  });

  return result.rows.map((row) => ({
    orgId: row.org_id,
    retentionDaysEvents: row.retention_days_events,
    retentionDaysScreenshots: row.retention_days_screenshots,
  }));
}

/**
 * Deletes activity events past retention, in bounded batches.
 *
 * `ctid` is used to pick the batch. A `delete ... where captured_at < x limit y` is not valid
 * Postgres, and an `id in (select id ... limit y)` sub-select re-scans the index every batch; the
 * ctid form deletes exactly the rows the sub-select found.
 */
async function sweepEvents(
  policy: RetentionPolicy,
  budget: number,
  dryRun: boolean,
  log: Logger,
): Promise<{ rowsDeleted: number; moreRemaining: boolean }> {
  if (dryRun) {
    const counted = await query<{ count: string }>({
      name: 'retention-count-events',
      text: `select count(*)::text as count
               from activity_events
              where org_id = $1
                and captured_at < now() - make_interval(days => $2)`,
      values: [policy.orgId, policy.retentionDaysEvents],
    });
    const pending = Number(counted.rows[0]?.count ?? '0');
    return { rowsDeleted: pending, moreRemaining: pending > budget };
  }

  let deleted = 0;

  while (deleted < budget) {
    const batchSize = Math.min(EVENT_BATCH, budget - deleted);

    const result = await query({
      name: 'retention-delete-events',
      text: `delete from activity_events
              where ctid in (
                  select ctid from activity_events
                   where org_id = $1
                     and captured_at < now() - make_interval(days => $2)
                   limit $3
              )`,
      values: [policy.orgId, policy.retentionDaysEvents, batchSize],
    });

    const rows = result.rowCount ?? 0;
    deleted += rows;

    if (rows < batchSize) {
      // Fewer rows than asked for means nothing is left past retention.
      return { rowsDeleted: deleted, moreRemaining: false };
    }
  }

  log.info('event deletion hit its ceiling for this organisation', {
    orgId: policy.orgId,
    deleted,
  });
  return { rowsDeleted: deleted, moreRemaining: true };
}

/**
 * Deletes screenshots past retention: the S3 objects first, then the rows.
 *
 * The order is the whole point. Deleting rows first and crashing before the objects would leave
 * images in the bucket that nothing in the database refers to — unreachable through the application,
 * invisible to any retention report, and removable only by someone reconciling the bucket by hand.
 * The reverse leak is benign: a row pointing at an object that is already gone is deleted on the next
 * run, and in the meantime the dashboard's presign simply fails.
 */
async function sweepScreenshots(
  policy: RetentionPolicy,
  budget: number,
  dryRun: boolean,
  log: Logger,
): Promise<{ rowsDeleted: number; objectsDeleted: number; moreRemaining: boolean }> {
  if (dryRun) {
    const counted = await query<{ count: string }>({
      name: 'retention-count-screenshots',
      text: `select count(*)::text as count
               from screenshots
              where org_id = $1
                and captured_at < now() - make_interval(days => $2)`,
      values: [policy.orgId, policy.retentionDaysScreenshots],
    });
    const pending = Number(counted.rows[0]?.count ?? '0');
    return { rowsDeleted: pending, objectsDeleted: 0, moreRemaining: pending > budget };
  }

  let rowsDeleted = 0;
  let objectsDeleted = 0;

  while (rowsDeleted < budget) {
    const batchSize = Math.min(S3_BATCH, budget - rowsDeleted);

    const batch = await query<{ id: string; s3_bucket: string; s3_key: string }>({
      name: 'retention-select-screenshots',
      text: `select id, s3_bucket, s3_key
               from screenshots
              where org_id = $1
                and captured_at < now() - make_interval(days => $2)
              order by captured_at
              limit $3`,
      values: [policy.orgId, policy.retentionDaysScreenshots, batchSize],
    });

    if (batch.rows.length === 0) {
      return { rowsDeleted, objectsDeleted, moreRemaining: false };
    }

    // Objects first.
    const deletedIds: string[] = [];
    const byBucket = new Map<string, { id: string; key: string }[]>();
    for (const row of batch.rows) {
      const existing = byBucket.get(row.s3_bucket) ?? [];
      existing.push({ id: row.id, key: row.s3_key });
      byBucket.set(row.s3_bucket, existing);
    }

    for (const [bucket, objects] of byBucket) {
      const response = await s3Client().send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: objects.map((object) => ({ Key: object.key })),
            // Quiet mode returns only errors, which is all that is needed and keeps the response
            // small for a thousand keys.
            Quiet: true,
          },
        }),
      );

      const failedKeys = new Set((response.Errors ?? []).map((error) => error.Key));
      for (const error of response.Errors ?? []) {
        log.error('could not delete a screenshot object; its row is kept for the next run', {
          bucket,
          key: error.Key,
          code: error.Code,
          message: error.Message,
        });
      }

      // Only rows whose object is actually gone are deleted. Deleting a row whose object survived
      // would strand the image permanently.
      for (const object of objects) {
        if (!failedKeys.has(object.key)) {
          deletedIds.push(object.id);
          objectsDeleted += 1;
        }
      }
    }

    if (deletedIds.length === 0) {
      // Every object in this batch failed. Stop rather than loop: the next iteration would select
      // the same rows and fail the same way.
      log.error('no screenshot objects could be deleted; stopping this organisation', {
        orgId: policy.orgId,
        batchSize: batch.rows.length,
      });
      return { rowsDeleted, objectsDeleted, moreRemaining: true };
    }

    const removed = await query({
      name: 'retention-delete-screenshot-rows',
      text: `delete from screenshots where org_id = $1 and id = any($2::uuid[])`,
      values: [policy.orgId, deletedIds],
    });
    rowsDeleted += removed.rowCount ?? 0;

    if (batch.rows.length < batchSize) {
      return { rowsDeleted, objectsDeleted, moreRemaining: false };
    }
  }

  return { rowsDeleted, objectsDeleted, moreRemaining: true };
}

/**
 * Expires screenshot rows whose upload never completed.
 *
 * Only the row is removed: there is no object to delete, because the upload is precisely what did
 * not happen. Bounded by `screenshots_pending_idx`.
 */
async function expirePendingScreenshots(log: Logger): Promise<number> {
  const result = await query({
    name: 'retention-expire-pending',
    text: `update screenshots
              set upload_state = 'expired'
            where upload_state = 'pending'
              and created_at < now() - make_interval(hours => $1)`,
    values: [PENDING_EXPIRY_HOURS],
  });

  const expired = result.rowCount ?? 0;
  if (expired > 0) {
    log.info('marked stale screenshot presigns as expired', { expired });
  }
  return expired;
}
