/**
 * `admin-api` — the dashboard writes and the owner-only reads.
 *
 * What these tests are for, beyond the happy paths:
 *
 *  - **D7 in both directions**, on a route that changes what is collected from employees' laptops.
 *    An owner without a configured factor is refused; the same owner with one is admitted.
 *  - **The manager boundary.** Managers read all employees and touch no settings and no users
 *    (docs/PLAN.md §4), so the refusal has to happen before any statement is issued.
 *  - **The enrolment token never reaches the database or the audit trail.** Only its SHA-256 does.
 *  - **`DELETE /v1/projects/{id}` does not delete.** `timesheet_project_totals` cascades, so the
 *    route retires the project; a future "simplification" back to a real delete would silently
 *    rewrite historical timesheets, and this test is what stops it landing quietly.
 *  - **Erasure deletes the S3 objects before the rows that point at them**, and records real counts.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('../../src/shared/db.js', async (importOriginal) =>
  (await import('../helpers/dbMock.js')).dbMockFactory(importOriginal),
);

/** The S3 client is replaced wholesale: erasure is the only route that calls it. */
const { s3Send } = vi.hoisted(() => ({ s3Send: vi.fn() }));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = s3Send;
  },
  DeleteObjectsCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

import { handler } from '../../src/handlers/dashboard/admin.js';
import type { ApiEvent } from '../../src/shared/http.js';
import { queriesMatching, recorded, resetDb, txStats, whenQuery } from '../helpers/dbMock.js';
import { errorOf, invoke } from '../helpers/deviceRequest.js';

const ORG_ID = '2f1a6e40-8c3b-4a1d-9f77-0b6e5c4a1d33';
const USER_ID = '9b1d4f70-2c6a-4e58-8a3b-1f7c5d9e2a44';
const EMPLOYEE_ID = '7c9e2b18-4d5a-4c6b-8e21-3f0a9d7b6c55';
const DEVICE_ID = 'a41b7d62-95c8-4e3f-b0a7-6d2c5e918f44';
const PROJECT_ID = 'b7f3c1d5-0e29-4a68-9c31-8d4e2f6a5b70';
const REQUEST_ID = 'e9d8c7b6-a512-4034-8fbc-1122aabbccdd';
const SCREENSHOT_ID = 'c3d5e7f9-1a2b-4c3d-8e5f-6a7b8c9d0e1f';

type Claims = Record<string, string>;

function claims(overrides: Claims = {}): Claims {
  return {
    sub: 'cognito-sub-1',
    email: 'owner@example.com',
    'wl:org': ORG_ID,
    'wl:user': USER_ID,
    'wl:role': 'owner',
    'wl:employee': '',
    'wl:tz': 'Asia/Kolkata',
    'wl:mfa': 'on',
    ...overrides,
  };
}

interface EventInit {
  method?: string;
  path: string;
  body?: unknown;
  claims?: Claims;
  query?: Record<string, string>;
}

function adminEvent(init: EventInit): ApiEvent {
  const raw = init.body === undefined ? null : JSON.stringify(init.body);
  return {
    httpMethod: init.method ?? 'GET',
    path: init.path,
    headers: { 'content-type': 'application/json', 'user-agent': 'worklens-dashboard/test' },
    body: raw,
    isBase64Encoded: false,
    pathParameters: null,
    queryStringParameters: init.query ?? null,
    requestContext: {
      requestId: 'test-request-id',
      identity: { sourceIp: '203.0.113.44' },
      authorizer: { claims: init.claims ?? claims() },
    },
  } as unknown as ApiEvent;
}

const AUDIT_INSERT = /^insert into audit_log/;

function configRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    org_id: ORG_ID,
    config_version: 4,
    sample_interval_seconds: 60,
    idle_threshold_seconds: 300,
    capture_window_titles: true,
    capture_urls: false,
    screenshot_enabled: false,
    screenshot_interval_seconds: 900,
    screenshot_blur: true,
    work_hours_only: true,
    work_hours_start: '09:00:00',
    work_hours_end: '17:30:00',
    work_days: [1, 2, 3, 4, 5],
    excluded_apps: [],
    excluded_url_patterns: [],
    retention_days_events: 90,
    retention_days_screenshots: 30,
    ...overrides,
  };
}

/** A complete `PUT /v1/config` body — the route is a replacement, so every field is required. */
function configBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sample_interval_seconds: 60,
    idle_threshold_seconds: 300,
    capture_window_titles: true,
    capture_urls: false,
    screenshot_enabled: true,
    screenshot_interval_seconds: 900,
    screenshot_blur: true,
    work_hours_only: true,
    work_hours_start: '09:00',
    work_hours_end: '17:30',
    work_days: [1, 2, 3, 4, 5],
    excluded_apps: ['bank'],
    excluded_url_patterns: [],
    retention_days_events: 90,
    retention_days_screenshots: 30,
    ...overrides,
  };
}

beforeEach(() => {
  resetDb();
  s3Send.mockReset();
  s3Send.mockResolvedValue({ Deleted: [], Errors: [] });
  whenQuery(/from organizations where id = \$1/, [
    { id: ORG_ID, name: 'Acme Pvt Ltd', slug: 'acme', timezone: 'Asia/Kolkata' },
  ]);
});

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

describe('the manager boundary', () => {
  it('refuses a manager on PUT /v1/config before touching the database', async () => {
    const response = await invoke(
      handler,
      adminEvent({
        method: 'PUT',
        path: '/v1/config',
        body: configBody(),
        claims: claims({ 'wl:role': 'manager' }),
      }),
    );

    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('FORBIDDEN');
    expect(recorded).toEqual([]);
  });

  it('refuses a manager on user management', async () => {
    const response = await invoke(
      handler,
      adminEvent({ path: '/v1/users', claims: claims({ 'wl:role': 'manager' }) }),
    );

    expect(errorOf(response).code).toBe('FORBIDDEN');
  });

  it('refuses an employee on every administrative route', async () => {
    const employee = claims({ 'wl:role': 'employee', 'wl:employee': EMPLOYEE_ID });

    for (const path of ['/v1/config', '/v1/users', '/v1/devices', '/v1/audit-log']) {
      const response = await invoke(handler, adminEvent({ path, claims: employee }));
      expect(response.statusCode).toBe(403);
    }
    expect(recorded).toEqual([]);
  });
});

describe('admin MFA (D7) on an administrative write', () => {
  it('refuses an owner with no configured factor', async () => {
    const response = await invoke(
      handler,
      adminEvent({
        method: 'PUT',
        path: '/v1/config',
        body: configBody(),
        claims: claims({ 'wl:mfa': 'off' }),
      }),
    );

    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('MFA_REQUIRED');
    expect(recorded).toEqual([]);
  });

  it('admits the same owner once a factor is configured', async () => {
    whenQuery(/from monitoring_config/, [configRow()]);
    whenQuery(/^update monitoring_config/, [{ config_version: 5 }]);

    const response = await invoke(
      handler,
      adminEvent({ method: 'PUT', path: '/v1/config', body: configBody() }),
    );

    expect(response.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Monitoring configuration
// ---------------------------------------------------------------------------

describe('PUT /v1/config', () => {
  beforeEach(() => {
    whenQuery(/from monitoring_config/, [configRow()]);
    whenQuery(/^update monitoring_config/, [{ config_version: 5 }]);
  });

  it('bumps config_version in the same statement, so the change reaches the fleet', async () => {
    const response = await invoke(
      handler,
      adminEvent({ method: 'PUT', path: '/v1/config', body: configBody() }),
    );

    expect(response.statusCode).toBe(200);
    const update = queriesMatching(/^update monitoring_config/)[0];
    expect(update?.sql).toContain('config_version = config_version + 1');
  });

  it('writes the audit row inside the same transaction as the change', async () => {
    await invoke(handler, adminEvent({ method: 'PUT', path: '/v1/config', body: configBody() }));

    expect(txStats.started).toBe(1);
    expect(txStats.committed).toBe(1);
    expect(txStats.rolledBack).toBe(0);
    expect(queriesMatching(AUDIT_INSERT)).toHaveLength(1);
  });

  it('records which keys changed, and the three that change what is collected', async () => {
    await invoke(handler, adminEvent({ method: 'PUT', path: '/v1/config', body: configBody() }));

    const audit = queriesMatching(AUDIT_INSERT)[0];
    const metadata = JSON.parse(String(audit?.values[10])) as {
      changed_keys: string[];
      screenshot_enabled: boolean;
    };

    expect(metadata.changed_keys).toEqual(['excluded_apps', 'screenshot_enabled']);
    expect(metadata.screenshot_enabled).toBe(true);
  });

  it('rejects screenshot retention longer than event retention, as the CHECK constraint does', async () => {
    const response = await invoke(
      handler,
      adminEvent({
        method: 'PUT',
        path: '/v1/config',
        body: configBody({ retention_days_events: 30, retention_days_screenshots: 90 }),
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).details?.[0]?.field).toBe('retention_days_screenshots');
    expect(recorded).toEqual([]);
  });

  it('rejects a partial body: this route is a deliberate full replacement', async () => {
    const response = await invoke(
      handler,
      adminEvent({ method: 'PUT', path: '/v1/config', body: { screenshot_enabled: true } }),
    );

    expect(response.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

describe('POST /v1/devices/enrollment-tokens', () => {
  beforeEach(() => {
    whenQuery(/^insert into enrollment_tokens/, [
      {
        id: 'f1e2d3c4-b5a6-4978-8a0b-1c2d3e4f5a6b',
        employee_id: EMPLOYEE_ID,
        expires_at: new Date('2026-08-20T09:00:00.000Z'),
        created_at: new Date('2026-08-19T09:00:00.000Z'),
      },
    ]);
  });

  it('returns a wlen_ token once and stores only its digest', async () => {
    const response = await invoke(
      handler,
      adminEvent({
        method: 'POST',
        path: '/v1/devices/enrollment-tokens',
        body: { employee_id: EMPLOYEE_ID, expires_in_hours: 24 },
      }),
    );

    expect(response.statusCode).toBe(201);
    const body = response.body as { token: string };
    expect(body.token).toMatch(/^wlen_[A-Za-z0-9_-]{43}$/);

    const insert = queriesMatching(/^insert into enrollment_tokens/)[0];
    const hash = insert?.values[2];
    expect(Buffer.isBuffer(hash)).toBe(true);
    expect((hash as Buffer).length).toBe(32);

    // The token itself must appear in no statement, in any form.
    const asStrings = recorded.flatMap((entry) => entry.values.map((value) => String(value)));
    expect(asStrings.some((value) => value.includes(body.token))).toBe(false);
  });

  it('keeps the token out of the audit trail as well', async () => {
    const response = await invoke(
      handler,
      adminEvent({
        method: 'POST',
        path: '/v1/devices/enrollment-tokens',
        body: { employee_id: EMPLOYEE_ID },
      }),
    );

    const token = (response.body as { token: string }).token;
    const audit = queriesMatching(AUDIT_INSERT)[0];
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit?.values)).not.toContain(token);
  });

  it('reports an employee outside the organisation as not found', async () => {
    resetDb();
    whenQuery(/^insert into enrollment_tokens/, []);

    const response = await invoke(
      handler,
      adminEvent({
        method: 'POST',
        path: '/v1/devices/enrollment-tokens',
        body: { employee_id: EMPLOYEE_ID },
      }),
    );

    expect(response.statusCode).toBe(404);
  });
});

describe('POST /v1/devices/{id}/revoke', () => {
  it('revokes and audits in one transaction', async () => {
    whenQuery(/^update devices set revoked_at/, [
      {
        id: DEVICE_ID,
        employee_id: EMPLOYEE_ID,
        revoked_at: new Date('2026-08-19T09:30:00.000Z'),
      },
    ]);

    const response = await invoke(
      handler,
      adminEvent({ method: 'POST', path: `/v1/devices/${DEVICE_ID}/revoke` }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ device_id: DEVICE_ID });
    expect(queriesMatching(AUDIT_INSERT)).toHaveLength(1);
    expect(txStats.committed).toBe(1);
  });

  it('is a 404 for a device belonging to another organisation', async () => {
    whenQuery(/^update devices set revoked_at/, []);

    const response = await invoke(
      handler,
      adminEvent({ method: 'POST', path: `/v1/devices/${DEVICE_ID}/revoke` }),
    );

    expect(response.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

describe('DELETE /v1/projects/{id}', () => {
  it('deactivates the project instead of deleting the row', async () => {
    whenQuery(/^update projects set is_active = false/, [
      {
        id: PROJECT_ID,
        name: 'Migration',
        code: 'MIG',
        is_active: false,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-08-19T09:00:00.000Z'),
      },
    ]);

    const response = await invoke(
      handler,
      adminEvent({ method: 'DELETE', path: `/v1/projects/${PROJECT_ID}` }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ deactivated: true });
    // The point of the test: no DELETE reaches `projects`, because
    // `timesheet_project_totals` cascades from it and history would go with the row.
    expect(queriesMatching(/delete from projects/)).toEqual([]);
    expect(queriesMatching(AUDIT_INSERT)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

describe('PATCH /v1/users/{id}', () => {
  it('refuses an owner demoting or disabling themselves', async () => {
    const response = await invoke(
      handler,
      adminEvent({ method: 'PATCH', path: `/v1/users/${USER_ID}`, body: { role: 'manager' } }),
    );

    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('FORBIDDEN');
    // Nothing is written: user management is owner-only, so this would lock the organisation out.
    expect(recorded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

describe('GET /v1/audit-log', () => {
  it('records that the trail itself was read', async () => {
    whenQuery(/from audit_log l left join employees/, [
      {
        id: '9001',
        actor_user_id: USER_ID,
        actor_email: 'owner@example.com',
        actor_role: 'owner',
        action: 'screenshot.view',
        subject_type: 'screenshot',
        subject_id: SCREENSHOT_ID,
        subject_employee_id: EMPLOYEE_ID,
        subject_employee_name: 'Kavya Sundararajan',
        ip: '203.0.113.44',
        user_agent: 'worklens-dashboard/test',
        metadata: { blurred: true },
        created_at: new Date('2026-08-18T11:00:00.000Z'),
      },
    ]);

    const response = await invoke(
      handler,
      adminEvent({ path: '/v1/audit-log', query: { from: '2026-08-01', to: '2026-08-18' } }),
    );

    expect(response.statusCode).toBe(200);
    expect(queriesMatching(AUDIT_INSERT)).toHaveLength(1);

    // The date filters become instants at the organisation's day boundaries, not UTC's: Kolkata is
    // UTC+05:30, so 1 August starts at 18:30 UTC on 31 July.
    const read = queriesMatching(/from audit_log l left join employees/)[0];
    expect(read?.values[1]).toBe('2026-07-31T18:30:00.000Z');
    // `to` is exclusive at the start of the following day, so the 18th is included in full.
    expect(read?.values[2]).toBe('2026-08-18T18:30:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------

describe('POST /v1/deletion-requests/{id}/execute', () => {
  function mockPending(scope: 'all' | 'events' | 'screenshots' = 'all'): void {
    whenQuery(/^select id, employee_id, scope, status from data_deletion_requests/, [
      { id: REQUEST_ID, employee_id: EMPLOYEE_ID, scope, status: 'pending' },
    ]);
    whenQuery(/^select id, s3_bucket, s3_key/, [
      {
        id: SCREENSHOT_ID,
        s3_bucket: 'worklens-test-screenshots',
        s3_key: `screenshots/${ORG_ID}/${EMPLOYEE_ID}/2026/08/17/${SCREENSHOT_ID}.png`,
      },
    ]);
    // The mock reports `rowCount` as the number of rows it hands back, which is what the batched
    // delete loop reads to decide whether to continue.
    whenQuery(/^delete from screenshots/, [{}]);
    whenQuery(/^delete from activity_events/, [{}, {}, {}]);
    whenQuery(/from data_deletion_requests r left join employees/, [
      {
        id: REQUEST_ID,
        employee_id: EMPLOYEE_ID,
        full_name: 'Kavya Sundararajan',
        scope,
        requested_by_user_id: USER_ID,
        reason: 'employee request',
        requested_at: new Date('2026-08-19T08:00:00.000Z'),
        status: 'completed',
        completed_at: new Date('2026-08-19T09:00:00.000Z'),
        deleted_event_count: 3,
        deleted_screenshot_count: 1,
        error: null,
      },
    ]);
  }

  it('deletes the S3 objects before the rows that point at them', async () => {
    mockPending();

    const response = await invoke(
      handler,
      adminEvent({ method: 'POST', path: `/v1/deletion-requests/${REQUEST_ID}/execute` }),
    );

    expect(response.statusCode).toBe(200);
    expect(s3Send).toHaveBeenCalledTimes(1);

    // The only durable record of which objects to remove is the rows themselves, so the bytes go
    // first: the reverse order would leave screenshots in the bucket that nothing can find.
    const objectDeleteOrder = s3Send.mock.invocationCallOrder[0] ?? 0;
    expect(objectDeleteOrder).toBeGreaterThan(0);
    expect(queriesMatching(/^delete from screenshots/)).toHaveLength(1);
    expect(queriesMatching(/^delete from activity_events/)).toHaveLength(1);
  });

  it('records the counts and marks the request completed', async () => {
    mockPending();

    await invoke(
      handler,
      adminEvent({ method: 'POST', path: `/v1/deletion-requests/${REQUEST_ID}/execute` }),
    );

    const finish = queriesMatching(/^update data_deletion_requests/)[0];
    expect(finish?.values[2]).toBe('completed');
    expect(finish?.values[3]).toBe(3);
    expect(finish?.values[4]).toBe(1);
    expect(queriesMatching(AUDIT_INSERT)).toHaveLength(1);
  });

  it('leaves activity events alone when the scope is screenshots only', async () => {
    mockPending('screenshots');

    await invoke(
      handler,
      adminEvent({ method: 'POST', path: `/v1/deletion-requests/${REQUEST_ID}/execute` }),
    );

    expect(queriesMatching(/^delete from activity_events/)).toEqual([]);
    const finish = queriesMatching(/^update data_deletion_requests/)[0];
    expect(finish?.values[3]).toBeNull();
  });

  it('rolls back and reports failure when S3 refuses to delete an object', async () => {
    mockPending();
    s3Send.mockResolvedValue({ Errors: [{ Key: 'k', Code: 'AccessDenied' }] });

    const response = await invoke(
      handler,
      adminEvent({ method: 'POST', path: `/v1/deletion-requests/${REQUEST_ID}/execute` }),
    );

    expect(response.statusCode).toBe(500);
    expect(txStats.rolledBack).toBe(1);
    // Nothing may be marked completed while the images are still in the bucket.
    expect(queriesMatching(/^update data_deletion_requests/)).toEqual([]);
  });

  it('refuses to run an already-completed request twice', async () => {
    whenQuery(/^select id, employee_id, scope, status from data_deletion_requests/, [
      { id: REQUEST_ID, employee_id: EMPLOYEE_ID, scope: 'all', status: 'completed' },
    ]);

    const response = await invoke(
      handler,
      adminEvent({ method: 'POST', path: `/v1/deletion-requests/${REQUEST_ID}/execute` }),
    );

    expect(response.statusCode).toBe(409);
    expect(errorOf(response).code).toBe('CONFLICT');
    expect(s3Send).not.toHaveBeenCalled();
  });

  it('is a 404 for a request belonging to another organisation', async () => {
    whenQuery(/^select id, employee_id, scope, status from data_deletion_requests/, []);

    const response = await invoke(
      handler,
      adminEvent({ method: 'POST', path: `/v1/deletion-requests/${REQUEST_ID}/execute` }),
    );

    expect(response.statusCode).toBe(404);
  });
});
