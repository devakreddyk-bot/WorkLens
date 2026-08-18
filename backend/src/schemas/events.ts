/**
 * `POST /v1/device/events`.
 *
 * This schema is the enforcement point for the promise WorkLens makes to the people it
 * monitors, so it is worth being explicit about which rules exist for validation and which
 * exist for privacy.
 *
 * The privacy rule is the idle rule. `activity_events_idle_no_attribution_chk` says an idle
 * event carries no application, no window title and no URL, and `docs/RESPONSIBLE_USE.md`
 * tells employees exactly that: idle minutes are attributed to nothing. The database will
 * refuse a violating row either way — but a CHECK violation surfaces as a 500 with a
 * constraint name, and the agent author cannot tell from that which of 500 events was wrong.
 * Checking it here names the event and the field.
 *
 * The rest mirror the column constraints so that a bad payload fails at the boundary rather
 * than as a Postgres error: the `event_type` enum, `duration_seconds` 0..3600, and the length
 * caps on every text column.
 */

import { z } from 'zod';

import { bounded, isoInstant, uuid } from './common.js';

/** `activity_events.event_type` — the CHECK constraint's exact value set, in its order. */
export const EVENT_TYPES = [
  'window_sample',
  'idle_state',
  'session_start',
  'session_end',
  'notice_ack',
  'agent_health',
] as const;

/**
 * The attribution fields, which are exactly the fields the idle constraint forbids on an idle
 * event. Kept as one list so the schema check and the error messages cannot drift from each
 * other, and so adding a sixth attribution column forces a decision here.
 */
export const ATTRIBUTION_FIELDS = [
  'app_name',
  'app_exe',
  'window_title',
  'url_host',
  'url_title',
] as const;

/**
 * `activity_events.duration_seconds` is `between 0 and 3600`.
 *
 * The upper bound is a real defence, not tidiness: a laptop resumed from sleep, or one whose
 * clock jumped, can otherwise report a single sample spanning days and inject it into a
 * timesheet as work.
 */
const MAX_DURATION_SECONDS = 3600;

const activityEventShape = z
  .object({
    /** Client-generated, and the per-event idempotency key. */
    client_event_id: uuid(),
    event_type: z.enum(EVENT_TYPES),
    captured_at: isoInstant(),

    duration_seconds: z
      .number()
      .int('must be a whole number of seconds')
      .min(0)
      .max(MAX_DURATION_SECONDS, `must not exceed ${MAX_DURATION_SECONDS}s (one hour)`)
      .default(0),

    // All optional. When a sample is idle, or when the relevant capture setting is off, the
    // agent omits the field rather than sending a placeholder — so `null` is not accepted
    // either: there is one way to say "nothing", which is to say nothing.
    app_name: bounded(200).optional(),
    app_exe: bounded(400).optional(),
    // Titles may legitimately be empty: a window can have no title at all.
    window_title: bounded(500, 0).optional(),
    url_host: bounded(253).optional(),
    url_title: bounded(500, 0).optional(),

    is_idle: z.boolean(),
  })
  .strict();

export const activityEventSchema = activityEventShape.superRefine((event, ctx) => {
  if (!event.is_idle) return;

  for (const field of ATTRIBUTION_FIELDS) {
    if (event[field] === undefined) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [field],
      message:
        `must be absent when is_idle is true: idle time is attributed to no application ` +
        `(constraint activity_events_idle_no_attribution_chk)`,
    });
  }
});

export type ActivityEvent = z.output<typeof activityEventSchema>;

export const ingestBatchSchema = z
  .object({
    events: z
      .array(activityEventSchema)
      .min(1, 'must contain at least one event')
      /**
       * A `client_event_id` repeated inside one batch is an agent bug, and one worth
       * reporting rather than absorbing. `on conflict do nothing` would swallow the
       * repetition and the response would then claim a duplicate that the server had in fact
       * never seen before, which makes the accepted/duplicate counts meaningless as a signal
       * that the agent's local buffer is behaving.
       */
      .superRefine((events, ctx) => {
        const seen = new Set<string>();
        events.forEach((event, index) => {
          if (seen.has(event.client_event_id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, 'client_event_id'],
              message: 'is repeated within this batch; each event needs its own id',
            });
          }
          seen.add(event.client_event_id);
        });
      }),
  })
  .strict();

export type IngestBatch = z.output<typeof ingestBatchSchema>;

/**
 * `ingest_batches.idempotency_key` is `length between 16 and 128`.
 *
 * The agent computes it as the SHA-256 of the sorted `client_event_id` list, so 64 hex
 * characters is what actually arrives — but the key is opaque to the server and the range is
 * kept wide so a future agent can change how it derives one without a backend deploy. The
 * character class is restricted because this value lands in a unique index and in log lines,
 * and there is no reason for it to contain anything but a token's worth of characters.
 */
export const idempotencyKeySchema = z
  .string()
  .min(16, 'must be at least 16 characters')
  .max(128, 'must be at most 128 characters')
  .regex(/^[A-Za-z0-9_.:-]+$/, 'may contain only letters, digits and _ . : -');

/**
 * Counts the events in a not-yet-validated body.
 *
 * Used to reject an oversized batch *before* validating it. Validating first would mean
 * running the full schema — including a per-event superRefine — over an array a hostile or
 * broken client chose the length of, which is work the request has not earned. Returns
 * `undefined` when the body is not a shape with an events array, and lets the real schema
 * produce the proper field-level error for that.
 */
export function batchEventCount(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const events = (body as { events?: unknown }).events;
  return Array.isArray(events) ? events.length : undefined;
}
