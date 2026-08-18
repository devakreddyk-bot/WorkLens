/**
 * `POST /v1/device/events`.
 *
 * Four behaviours here are the ones an agent's correctness depends on, so they are pinned hard:
 * a retried batch is a 200 that tells the agent to drop its copy, an oversized batch is refused
 * before it is validated, a device over its quota gets a `Retry-After` it can actually obey, and
 * an idle event carrying attribution is refused with the field named.
 *
 * The last one is a privacy invariant, not a validation nicety. `activity_events_idle_no_attribution_chk`
 * would reject the row anyway; the point of catching it here is that the response says *which*
 * event and *which* field, so an agent bug that starts attributing idle minutes to an application
 * is fixable rather than mysterious.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/shared/db.js', async (importOriginal) =>
  (await import('../helpers/dbMock.js')).dbMockFactory(importOriginal),
);

import { handler } from '../../src/handlers/device/ingestEvents.js';
import { config } from '../../src/shared/config.js';
import { queriesMatching, resetDb, whenQuery } from '../helpers/dbMock.js';
import {
  DEVICE_ID,
  EMPLOYEE_ID,
  ORG_ID,
  clearRootKeys,
  errorOf,
  installRootKeys,
  invoke,
  mockDeviceRow,
  signedEvent,
} from '../helpers/deviceRequest.js';

const BATCH_ID = 'b2c4d6e8-0a1b-4c3d-9e5f-7a8b9c0d1e2f';
const IDEMPOTENCY_KEY = 'a'.repeat(64);

/** Postgres reports an insert's row count; the mock derives it from the rows it hands back. */
function insertedRows(count: number): Record<string, never>[] {
  return Array.from({ length: count }, () => ({}));
}

let eventCounter = 0;

function activeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  eventCounter += 1;
  const suffix = String(eventCounter).padStart(12, '0');
  return {
    client_event_id: `11111111-2222-4333-8444-${suffix}`,
    event_type: 'window_sample',
    captured_at: '2026-08-18T09:30:00.000Z',
    duration_seconds: 60,
    app_name: 'Visual Studio Code',
    app_exe: 'code.exe',
    window_title: 'rollup.ts — worklens',
    is_idle: false,
    ...overrides,
  };
}

function idleEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  eventCounter += 1;
  const suffix = String(eventCounter).padStart(12, '0');
  return {
    client_event_id: `22222222-3333-4444-8555-${suffix}`,
    event_type: 'idle_state',
    captured_at: '2026-08-18T09:31:00.000Z',
    duration_seconds: 300,
    is_idle: true,
    ...overrides,
  };
}

function request(
  events: Record<string, unknown>[],
  headers: Record<string, string> = { 'idempotency-key': IDEMPOTENCY_KEY },
) {
  return signedEvent({
    method: 'POST',
    path: '/v1/device/events',
    body: { events },
    headers,
  });
}

/** Quota answer: a window with room to spare. */
function mockQuotaWithRoom(): void {
  whenQuery(/quota_event_count = case/, [
    { quota_event_count: 12, retry_after_seconds: 3400 },
  ]);
}

beforeEach(() => {
  resetDb();
  installRootKeys();
  mockDeviceRow();
  mockQuotaWithRoom();
});

afterEach(() => {
  clearRootKeys();
});

describe('ingest — idempotency', () => {
  it('accepts a fresh batch and reports the real counts', async () => {
    whenQuery(/^insert into ingest_batches/, [{ id: BATCH_ID }]);
    whenQuery(/^insert into activity_events/, insertedRows(3));

    const response = await invoke(
      handler,
      request([activeEvent(), activeEvent(), idleEvent()]),
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ accepted: 3, duplicates: 0, duplicate: false });
  });

  it('reports partially-seen events as duplicates rather than losing them', async () => {
    whenQuery(/^insert into ingest_batches/, [{ id: BATCH_ID }]);
    // Two of the three were already present under this device's client_event_id: a previous
    // attempt got further than the agent realised.
    whenQuery(/^insert into activity_events/, insertedRows(1));

    const response = await invoke(
      handler,
      request([activeEvent(), activeEvent(), activeEvent()]),
    );

    expect(response.body).toEqual({ accepted: 1, duplicates: 2, duplicate: false });
  });

  it('answers a retried batch with 200 and duplicate: true so the agent drops it', async () => {
    // The unique (device_id, idempotency_key) already held this batch, so the insert returned
    // no row.
    whenQuery(/^insert into ingest_batches/, []);

    const response = await invoke(handler, request([activeEvent(), activeEvent()]));

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ accepted: 0, duplicates: 2, duplicate: true });
    // The whole point of writing the batch row first: a retry costs one statement, not 500.
    expect(queriesMatching(/^insert into activity_events/)).toHaveLength(0);
  });

  it('writes the batch row before the events, with ON CONFLICT DO NOTHING on both', async () => {
    whenQuery(/^insert into ingest_batches/, [{ id: BATCH_ID }]);
    whenQuery(/^insert into activity_events/, insertedRows(1));

    await invoke(handler, request([activeEvent()]));

    const [batch] = queriesMatching(/^insert into ingest_batches/);
    const [events] = queriesMatching(/^insert into activity_events/);
    expect(batch?.sql).toContain('on conflict (device_id, idempotency_key) do nothing');
    expect(events?.sql).toContain('on conflict (device_id, client_event_id) do nothing');
  });

  it('inserts a whole batch in one statement rather than a loop', async () => {
    whenQuery(/^insert into ingest_batches/, [{ id: BATCH_ID }]);
    whenQuery(/^insert into activity_events/, insertedRows(50));

    await invoke(
      handler,
      request(Array.from({ length: 50 }, () => activeEvent())),
    );

    const inserts = queriesMatching(/^insert into activity_events/);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.sql).toContain('unnest');
  });

  it('takes org and employee from the verified identity, not from the payload', async () => {
    whenQuery(/^insert into ingest_batches/, [{ id: BATCH_ID }]);
    whenQuery(/^insert into activity_events/, insertedRows(1));

    await invoke(handler, request([activeEvent()]));

    const [insert] = queriesMatching(/^insert into activity_events/);
    expect(insert?.values[0]).toBe(ORG_ID);
    expect(insert?.values[1]).toBe(EMPLOYEE_ID);
    expect(insert?.values[2]).toBe(DEVICE_ID);
  });

  it('requires an Idempotency-Key header', async () => {
    const response = await invoke(handler, request([activeEvent()], {}));

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe('VALIDATION_FAILED');
    expect(errorOf(response).details?.[0]?.field).toBe('Idempotency-Key');
  });

  it('rejects a malformed Idempotency-Key', async () => {
    const response = await invoke(handler, request([activeEvent()], { 'idempotency-key': 'short' }));

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).details?.[0]?.field).toBe('Idempotency-Key');
  });
});

describe('ingest — batch size', () => {
  it('rejects a batch over MAX_EVENTS_PER_BATCH with 400 BATCH_TOO_LARGE', async () => {
    const oversized = Array.from({ length: config.MAX_EVENTS_PER_BATCH + 1 }, () => activeEvent());

    const response = await invoke(handler, request(oversized));

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe('BATCH_TOO_LARGE');
    expect(errorOf(response).message).toContain(String(config.MAX_EVENTS_PER_BATCH));
    // Refused before the schema ran over an array whose length the caller chose, and before any
    // quota was claimed.
    expect(queriesMatching(/quota_event_count = case/)).toHaveLength(0);
  });

  it('rejects an empty batch', async () => {
    const response = await invoke(handler, request([]));

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).details?.[0]?.field).toBe('events');
  });
});

describe('ingest — quota', () => {
  it('answers 429 with a Retry-After the agent can obey', async () => {
    whenQuery(/quota_event_count = case/, [
      { quota_event_count: config.DEVICE_QUOTA_EVENTS_PER_WINDOW + 25, retry_after_seconds: 1800 },
    ]);

    const response = await invoke(handler, request([activeEvent()]));

    expect(response.statusCode).toBe(429);
    expect(errorOf(response).code).toBe('QUOTA_EXCEEDED');
    expect(response.headers['retry-after']).toBe('1800');
    // Nothing was written: the quota decision precedes the batch row.
    expect(queriesMatching(/^insert into ingest_batches/)).toHaveLength(0);
  });

  it('never asks the agent to retry immediately', async () => {
    whenQuery(/quota_event_count = case/, [
      { quota_event_count: config.DEVICE_QUOTA_EVENTS_PER_WINDOW + 1, retry_after_seconds: 0 },
    ]);

    const response = await invoke(handler, request([activeEvent()]));

    expect(response.headers['retry-after']).toBe('1');
  });

  it('claims quota in one atomic UPDATE that both resets and increments', async () => {
    whenQuery(/^insert into ingest_batches/, [{ id: BATCH_ID }]);
    whenQuery(/^insert into activity_events/, insertedRows(1));

    await invoke(handler, request([activeEvent()]));

    const claims = queriesMatching(/quota_event_count = case/);
    expect(claims).toHaveLength(1);
    const sql = claims[0]?.sql ?? '';
    expect(sql).toMatch(/^update devices/);
    expect(sql).toContain('quota_window_started_at = case');
    expect(sql).toContain('returning quota_event_count');
    // The claim is for exactly the events in this batch.
    expect(claims[0]?.values[3]).toBe(1);
  });

  it('allows a batch that lands exactly on the limit', async () => {
    whenQuery(/quota_event_count = case/, [
      { quota_event_count: config.DEVICE_QUOTA_EVENTS_PER_WINDOW, retry_after_seconds: 60 },
    ]);
    whenQuery(/^insert into ingest_batches/, [{ id: BATCH_ID }]);
    whenQuery(/^insert into activity_events/, insertedRows(1));

    const response = await invoke(handler, request([activeEvent()]));

    expect(response.statusCode).toBe(200);
  });
});

describe('ingest — the idle rule', () => {
  it('rejects an idle event carrying a window title, naming the field', async () => {
    const response = await invoke(
      handler,
      request([activeEvent(), idleEvent({ window_title: 'Statement — HDFC Bank' })]),
    );

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe('VALIDATION_FAILED');

    const details = errorOf(response).details ?? [];
    expect(details.map((detail) => detail.field)).toContain('events.1.window_title');
    expect(details[0]?.message).toMatch(/activity_events_idle_no_attribution_chk/);
    expect(queriesMatching(/^insert into activity_events/)).toHaveLength(0);
  });

  it('rejects every attribution field an idle event carries, not just the first', async () => {
    const response = await invoke(
      handler,
      request([
        idleEvent({
          app_name: 'Chrome',
          app_exe: 'chrome.exe',
          window_title: 'anything',
          url_host: 'bank.example',
          url_title: 'anything',
        }),
      ]),
    );

    const fields = (errorOf(response).details ?? []).map((detail) => detail.field);
    expect(fields).toEqual([
      'events.0.app_name',
      'events.0.app_exe',
      'events.0.window_title',
      'events.0.url_host',
      'events.0.url_title',
    ]);
  });

  it('does not echo the offending window title back to the caller', async () => {
    const title = 'Statement — HDFC Bank';

    const response = await invoke(handler, request([idleEvent({ window_title: title })]));

    expect(JSON.stringify(response.body)).not.toContain(title);
  });

  it('accepts an idle event that attributes nothing', async () => {
    whenQuery(/^insert into ingest_batches/, [{ id: BATCH_ID }]);
    whenQuery(/^insert into activity_events/, insertedRows(1));

    const response = await invoke(handler, request([idleEvent()]));

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ accepted: 1 });
  });
});

describe('ingest — payload validation mirrors the schema constraints', () => {
  it('rejects a duration beyond the one-hour cap', async () => {
    const response = await invoke(handler, request([activeEvent({ duration_seconds: 3601 })]));

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).details?.[0]?.field).toBe('events.0.duration_seconds');
  });

  it('rejects an event type outside the enum', async () => {
    const response = await invoke(handler, request([activeEvent({ event_type: 'clipboard' })]));

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).details?.[0]?.field).toBe('events.0.event_type');
  });

  it('rejects a window title beyond the column cap', async () => {
    const response = await invoke(handler, request([activeEvent({ window_title: 'x'.repeat(501) })]));

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).details?.[0]?.field).toBe('events.0.window_title');
  });

  it('rejects a captured_at with no timezone rather than guessing one', async () => {
    const response = await invoke(
      handler,
      request([activeEvent({ captured_at: '2026-08-18T09:30:00' })]),
    );

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).details?.[0]?.field).toBe('events.0.captured_at');
  });

  it('rejects an impossible calendar date the regex would otherwise accept', async () => {
    const response = await invoke(
      handler,
      request([activeEvent({ captured_at: '2026-02-30T09:30:00.000Z' })]),
    );

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).details?.[0]?.message).toMatch(/real calendar instant/);
  });

  it('rejects a captured_at implausibly far in the future', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();

    const response = await invoke(handler, request([activeEvent({ captured_at: future })]));

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).details?.[0]?.message).toMatch(/future/);
  });

  it('rejects a batch that repeats a client_event_id', async () => {
    const duplicated = activeEvent();

    const response = await invoke(handler, request([duplicated, { ...duplicated }]));

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).details?.[0]?.field).toBe('events.1.client_event_id');
  });

  it('rejects a payload that tries to set the server-derived category', async () => {
    const response = await invoke(handler, request([activeEvent({ category: 'Development' })]));

    // `category` and `project_id` are derived by the aggregation job from the org's own rules. A
    // device that could set them could label its own time.
    expect(response.statusCode).toBe(400);
    expect(errorOf(response).details?.[0]?.message).toMatch(/unrecognized key/i);
  });

  it('rejects a payload that tries to claim another employee', async () => {
    const response = await invoke(
      handler,
      request([activeEvent({ employee_id: '00000000-0000-4000-8000-000000000000' })]),
    );

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).details?.[0]?.message).toMatch(/unrecognized key/i);
  });
});

describe('ingest — the notice gate', () => {
  it('refuses activity data from a device whose notice was never acknowledged', async () => {
    resetDb();
    mockDeviceRow({ noticeAcknowledgedAt: null });
    mockQuotaWithRoom();

    const response = await invoke(handler, request([activeEvent()]));

    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('FORBIDDEN');
    expect(errorOf(response).message).toMatch(/acknowledgment of the monitoring notice/);
    // Refused before anything was read or written beyond authentication.
    expect(queriesMatching(/quota_event_count = case/)).toHaveLength(0);
    expect(queriesMatching(/^insert into ingest_batches/)).toHaveLength(0);
  });

  it('refuses a revoked device', async () => {
    resetDb();
    mockDeviceRow({ revokedAt: new Date('2026-08-17T00:00:00.000Z') });

    const response = await invoke(handler, request([activeEvent()]));

    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('DEVICE_REVOKED');
  });

  it('refuses a request whose signature does not match the body', async () => {
    const event = request([activeEvent()]);
    // Tampering with the body after signing is exactly what the body hash exists to catch.
    event.body = JSON.stringify({ events: [activeEvent({ duration_seconds: 3600 })] });

    const response = await invoke(handler, event);

    expect(response.statusCode).toBe(401);
    expect(errorOf(response).code).toBe('INVALID_SIGNATURE');
  });
});
