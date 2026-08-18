/**
 * `POST /v1/device/notice-ack`.
 *
 * `devices.notice_acknowledged_at` is the deployer's evidence that a monitored person was told
 * they were being monitored. So the interesting property is not that the route works — it is that
 * a retry does not move the timestamp. An agent that is offline-tolerant will send this more than
 * once, and a value that crept forward on every retry would record the moment of the last retry
 * rather than the moment of the acknowledgment, which is evidence of nothing.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/shared/db.js', async (importOriginal) =>
  (await import('../helpers/dbMock.js')).dbMockFactory(importOriginal),
);

import { handler } from '../../src/handlers/device/noticeAck.js';
import { queriesMatching, resetDb, whenQuery } from '../helpers/dbMock.js';
import {
  DEVICE_ID,
  EMPLOYEE_ID,
  clearRootKeys,
  errorOf,
  installRootKeys,
  invoke,
  mockDeviceRow,
  signedEvent,
} from '../helpers/deviceRequest.js';

const FIRST_ACK = new Date('2026-08-18T09:00:00.000Z');

function request() {
  return signedEvent({ method: 'POST', path: '/v1/device/notice-ack' });
}

/**
 * Models `set notice_acknowledged_at = coalesce(notice_acknowledged_at, now())` together with the
 * CTE that reports the pre-update value — the two halves that make the route idempotent.
 */
function mockAcknowledgeNotice(): void {
  let stored: Date | null = null;

  whenQuery(/notice_acknowledged_at = coalesce/, () => {
    const previous = stored;
    stored ??= FIRST_ACK;
    return [
      {
        device_id: DEVICE_ID,
        notice_acknowledged_at: stored,
        previous_acknowledged_at: previous,
      },
    ];
  });
}

beforeEach(() => {
  resetDb();
  installRootKeys();
  // Not yet acknowledged: this is the route that changes that, and it is deliberately not behind
  // the notice gate it satisfies.
  mockDeviceRow({ noticeAcknowledgedAt: null });
  mockAcknowledgeNotice();
});

afterEach(() => {
  clearRootKeys();
});

describe('notice-ack', () => {
  it('records the acknowledgment', async () => {
    const response = await invoke(handler, request());

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      device_id: DEVICE_ID,
      notice_acknowledged_at: FIRST_ACK.toISOString(),
      already_acknowledged: false,
    });
  });

  it('is idempotent: a second call neither fails nor moves the timestamp', async () => {
    const first = await invoke(handler, request());
    const second = await invoke(handler, request());

    expect(second.statusCode).toBe(200);
    expect(second.body.notice_acknowledged_at).toBe(first.body.notice_acknowledged_at);
    expect(second.body.already_acknowledged).toBe(true);
  });

  it('does not append a second audit row for a retry', async () => {
    await invoke(handler, request());
    await invoke(handler, request());

    // The employee acknowledged once. Two rows would misrepresent that, and the audit log cannot
    // be corrected afterwards — `worklens_app` has no UPDATE or DELETE on it by design.
    const audits = queriesMatching(/^insert into audit_log/);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.values).toContain('device.notice_acknowledged');
    expect(audits[0]?.values).toContain(EMPLOYEE_ID);
  });

  it('keeps the first moment with coalesce rather than assigning now()', async () => {
    await invoke(handler, request());

    const [update] = queriesMatching(/notice_acknowledged_at = coalesce/);
    expect(update?.sql).toContain('coalesce(d.notice_acknowledged_at, now())');
    // The pre-update value comes from a CTE, which is what makes "was this the first call?"
    // answerable in one statement.
    expect(update?.sql).toContain('with previous as');
  });

  it('takes no body, and says so rather than ignoring one', async () => {
    // A client-supplied acknowledgment time would be self-reported evidence, and accepting the
    // field only to ignore it would look like it worked.
    const event = signedEvent({
      method: 'POST',
      path: '/v1/device/notice-ack',
      body: { acknowledged_at: '2020-01-01T00:00:00.000Z' },
    });

    const response = await invoke(handler, event);

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).details?.[0]?.message).toMatch(/unrecognized key/i);
  });

  it('refuses a revoked device', async () => {
    resetDb();
    mockDeviceRow({ revokedAt: new Date('2026-08-17T00:00:00.000Z') });

    const response = await invoke(handler, request());

    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('DEVICE_REVOKED');
  });
});
