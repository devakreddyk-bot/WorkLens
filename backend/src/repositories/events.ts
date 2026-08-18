/**
 * Activity-event ingestion.
 *
 * Two properties are load-bearing here.
 *
 * **Idempotency.** The agent is allowed to be dumb and retry aggressively — it buffers to
 * SQLite, uploads, and deletes local rows only on a 2xx, so any lost response becomes a
 * retry. Both writes below absorb that: the batch row has a unique `(device_id,
 * idempotency_key)` and the events have a unique `(device_id, client_event_id)`, and both
 * use `on conflict do nothing`. A retried batch is not an error, it is a no-op that reports
 * itself as one.
 *
 * **One statement per batch.** A batch is up to 500 events. Inserting them in a loop would
 * be 500 round trips to a database in a private subnet, which at ~1 ms each dominates the
 * invocation, and — worse — makes the cost of a batch depend on the network rather than on
 * the work. `unnest` over parallel arrays turns the whole batch into a single insert.
 */

import type { QueryResultRow } from 'pg';

import type { Tx } from './executor.js';
import { run, runOne } from './executor.js';

export interface IngestBatchInput {
  idempotencyKey: string;
  eventCount: number;
  byteCount: number;
}

/**
 * Records the batch. Returns `undefined` when the batch has already been recorded, which is
 * how a retry is detected — the handler answers 200 with `duplicate: true` so the agent
 * drops its local copy instead of retrying forever.
 *
 * This is inserted *before* the events, so the conflict is discovered in one statement
 * rather than after 500 events have been offered to the database.
 */
export async function insertIngestBatch(
  orgId: string,
  deviceId: string,
  input: IngestBatchInput,
  tx?: Tx,
): Promise<{ id: string } | undefined> {
  return runOne<{ id: string }>(
    {
      name: 'ingest-batch-insert',
      text: `insert into ingest_batches (org_id, device_id, idempotency_key, event_count, byte_count)
                  values ($1, $2, $3, $4, $5)
             on conflict (device_id, idempotency_key) do nothing
               returning id`,
      values: [orgId, deviceId, input.idempotencyKey, input.eventCount, input.byteCount],
    },
    tx,
  );
}

/**
 * One activity event, in the shape the insert needs.
 *
 * `org_id`, `employee_id` and `device_id` are absent by design: they come from the verified
 * device identity and are passed separately, so there is no field here for a payload to put
 * them in. A device cannot attribute its events to another employee because the wire format
 * gives it nowhere to say so.
 *
 * `category` and `project_id` are absent for a different reason — they are derived
 * server-side by the aggregation job from `app_categories` and `project_rules`. Accepting
 * them from the device would let a tampered agent label its own time.
 */
export interface ActivityEventInput {
  client_event_id: string;
  event_type: string;
  captured_at: Date;
  duration_seconds: number;
  app_name?: string | undefined;
  app_exe?: string | undefined;
  window_title?: string | undefined;
  url_host?: string | undefined;
  url_title?: string | undefined;
  is_idle: boolean;
}

export interface InsertEventsResult {
  /** Rows the database actually created. */
  accepted: number;
  /** Events already present under this device's `client_event_id`. */
  duplicates: number;
}

/**
 * Inserts every event of a batch in one statement.
 *
 * The arrays are strictly parallel and are all the same length, so `unnest` zips them back
 * into rows. `duration_seconds` is cast to `integer[]` and `captured_at` to `timestamptz[]`
 * explicitly, because a bare parameter array arrives as `text[]` and the implicit cast
 * would be resolved per row rather than once.
 *
 * `on conflict do nothing` also covers the case of a batch that repeats a `client_event_id`
 * within itself: speculative insertion makes the second occurrence a no-op rather than an
 * error. The schema layer rejects such a batch anyway, so this is belt and braces.
 */
export async function insertActivityEvents(
  orgId: string,
  employeeId: string,
  deviceId: string,
  events: readonly ActivityEventInput[],
  tx?: Tx,
): Promise<InsertEventsResult> {
  if (events.length === 0) return { accepted: 0, duplicates: 0 };

  const result = await run<QueryResultRow>(
    {
      name: 'activity-events-insert',
      text: `insert into activity_events (
                   org_id, employee_id, device_id, client_event_id, event_type,
                   captured_at, duration_seconds, app_name, app_exe, window_title,
                   url_host, url_title, is_idle
                 )
                 select $1::uuid, $2::uuid, $3::uuid,
                        e.client_event_id, e.event_type, e.captured_at, e.duration_seconds,
                        e.app_name, e.app_exe, e.window_title, e.url_host, e.url_title,
                        e.is_idle
                   from unnest(
                          $4::uuid[], $5::text[], $6::timestamptz[], $7::integer[],
                          $8::text[], $9::text[], $10::text[], $11::text[], $12::text[],
                          $13::boolean[]
                        ) as e(client_event_id, event_type, captured_at, duration_seconds,
                               app_name, app_exe, window_title, url_host, url_title, is_idle)
            on conflict (device_id, client_event_id) do nothing`,
      values: [
        orgId,
        employeeId,
        deviceId,
        events.map((e) => e.client_event_id),
        events.map((e) => e.event_type),
        events.map((e) => e.captured_at.toISOString()),
        events.map((e) => e.duration_seconds),
        events.map((e) => e.app_name ?? null),
        events.map((e) => e.app_exe ?? null),
        events.map((e) => e.window_title ?? null),
        events.map((e) => e.url_host ?? null),
        events.map((e) => e.url_title ?? null),
        events.map((e) => e.is_idle),
      ],
    },
    tx,
  );

  const accepted = result.rowCount ?? 0;
  return { accepted, duplicates: events.length - accepted };
}
