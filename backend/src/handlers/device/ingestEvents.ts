/**
 * `POST /v1/device/events` — batched activity ingestion.
 *
 * The whole design assumption is that the agent is allowed to be dumb. It buffers to SQLite,
 * uploads, and deletes its local rows only on a 2xx, so every dropped connection becomes a
 * retry of a batch the server may or may not already hold. Rather than make the agent reason
 * about that, the server makes retries free: a batch is identified by an `Idempotency-Key`, and
 * a repeat is answered `200 {duplicate: true}` so the agent drops its copy and moves on.
 *
 * The order of operations is load-bearing:
 *
 *   1. `Idempotency-Key` present     — a batch without one cannot be deduplicated at all
 *   2. batch size                    — before validating 500 events the caller chose the count of
 *   3. schema validation             — including the idle rule, which is a privacy invariant
 *   4. quota                         — one atomic UPDATE; see repositories/devices.ts
 *   5. batch row, then events        — in one transaction, batch first so a retry costs one
 *                                      statement instead of 500
 *
 * Steps 4 and 5 are the two that must not be reordered. Claiming quota after inserting would
 * let a device over its limit still write, and inserting events before the batch row would mean
 * a retry did the expensive work before discovering it was a retry.
 */

import { config } from '../../shared/config.js';
import { consumeIngestQuota } from '../../repositories/devices.js';
import {
  insertActivityEvents,
  insertIngestBatch,
} from '../../repositories/events.js';
import type { ActivityEventInput } from '../../repositories/events.js';
import { batchEventCount, idempotencyKeySchema, ingestBatchSchema } from '../../schemas/events.js';
import { issuesToDetails, parseBody } from '../../schemas/parse.js';
import type { DeviceIdentity } from '../../middleware/deviceAuth.js';
import { withAcknowledgedNotice, withDeviceAuth } from '../../middleware/deviceAuth.js';
import { transaction } from '../../shared/db.js';
import { AppError, ErrorCode, errors } from '../../shared/errors.js';
import type { JsonResponse, RequestContext } from '../../shared/http.js';
import { ok, parseJsonBody, withHandler } from '../../shared/http.js';

const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * Reads and validates the `Idempotency-Key` header.
 *
 * Required rather than optional. Making it optional would mean every batch that omitted it was
 * un-deduplicatable, and the first network timeout would silently double an employee's day —
 * per-event `client_event_id` uniqueness would keep the rows correct, but `ingest_batches`
 * would lose its meaning as a record of what was actually received.
 */
function requireIdempotencyKey(ctx: RequestContext): string {
  const raw = ctx.headers[IDEMPOTENCY_HEADER];
  if (raw === undefined || raw.trim() === '') {
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      'The Idempotency-Key header is required so a retried batch can be recognised.',
      { details: [{ field: 'Idempotency-Key', message: 'header is required' }] },
    );
  }

  const parsed = idempotencyKeySchema.safeParse(raw.trim());
  if (!parsed.success) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, 'The Idempotency-Key header is malformed.', {
      details: issuesToDetails(parsed.error.issues).map((detail) => ({
        field: 'Idempotency-Key',
        message: detail.message,
      })),
    });
  }

  return parsed.data;
}

export const handler = withHandler(
  'ingest-events',
  withDeviceAuth(
    withAcknowledgedNotice(
      async (ctx: RequestContext, identity: DeviceIdentity): Promise<JsonResponse> => {
        const idempotencyKey = requireIdempotencyKey(ctx);

        const raw = parseJsonBody(ctx);

        const declaredCount = batchEventCount(raw);
        if (declaredCount !== undefined && declaredCount > config.MAX_EVENTS_PER_BATCH) {
          throw new AppError(
            ErrorCode.BATCH_TOO_LARGE,
            `A batch may contain at most ${config.MAX_EVENTS_PER_BATCH} events; this one has ` +
              `${declaredCount}. Split it and retry.`,
            {
              details: [
                {
                  field: 'events',
                  message: `must contain at most ${config.MAX_EVENTS_PER_BATCH} events`,
                },
              ],
              logContext: { events: declaredCount, limit: config.MAX_EVENTS_PER_BATCH },
            },
          );
        }

        const body = parseBody(ingestBatchSchema, raw);
        const events: readonly ActivityEventInput[] = body.events;

        const quota = await consumeIngestQuota(
          identity.orgId,
          identity.deviceId,
          events.length,
          {
            limit: config.DEVICE_QUOTA_EVENTS_PER_WINDOW,
            windowSeconds: config.DEVICE_QUOTA_WINDOW_SECONDS,
          },
        );

        if (quota === undefined) {
          // Revoked between authentication and here.
          throw errors.deviceRevoked(identity.deviceId);
        }

        if (!quota.allowed) {
          throw errors.quotaExceeded(quota.retryAfterSeconds, {
            events: quota.eventCount,
            limit: quota.limit,
            windowSeconds: config.DEVICE_QUOTA_WINDOW_SECONDS,
          });
        }

        const byteCount = Buffer.byteLength(ctx.rawBody, 'utf8');

        const outcome = await transaction(async (tx) => {
          const batch = await insertIngestBatch(
            identity.orgId,
            identity.deviceId,
            { idempotencyKey, eventCount: events.length, byteCount },
            tx,
          );

          // No row means the unique `(device_id, idempotency_key)` already held this batch: a
          // retry. Returning early skips the event insert entirely, which is the point of
          // writing the batch row first.
          if (batch === undefined) return undefined;

          const inserted = await insertActivityEvents(
            identity.orgId,
            identity.employeeId,
            identity.deviceId,
            events,
            tx,
          );

          return { batchId: batch.id, ...inserted };
        });

        if (outcome === undefined) {
          ctx.log.info('duplicate batch', { events: events.length });
          // A 200, not a 409: from the agent's point of view the batch has been delivered, and
          // the correct action is to drop its local copy. An error would make it retry forever.
          return ok({ accepted: 0, duplicates: events.length, duplicate: true });
        }

        ctx.log.info('batch ingested', {
          batchId: outcome.batchId,
          accepted: outcome.accepted,
          duplicates: outcome.duplicates,
          bytes: byteCount,
          quotaEvents: quota.eventCount,
        });

        return ok({
          accepted: outcome.accepted,
          // Non-zero when a previous attempt partially succeeded under a different batch key —
          // the per-event uniqueness catches those, so retries converge instead of doubling.
          duplicates: outcome.duplicates,
          duplicate: false,
        });
      },
    ),
  ),
);
