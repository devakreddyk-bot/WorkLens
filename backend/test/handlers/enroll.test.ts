/**
 * `POST /v1/device/enroll`.
 *
 * The properties under test are the ones that would be expensive to get wrong: a token works
 * exactly once, the three failure modes are distinguishable by the operator holding the token,
 * and the returned device secret exists only in the response — never in a statement sent to the
 * database.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/shared/db.js', async (importOriginal) =>
  (await import('../helpers/dbMock.js')).dbMockFactory(importOriginal),
);

import { handler } from '../../src/handlers/device/enroll.js';
import { queriesMatching, recorded, resetDb, txStats, whenQuery } from '../helpers/dbMock.js';
import {
  DEVICE_ID,
  EMPLOYEE_ID,
  KEY_VERSION,
  ORG_ID,
  clearRootKeys,
  deviceSecret,
  enrollmentToken,
  errorOf,
  installRootKeys,
  invoke,
  plainEvent,
} from '../helpers/deviceRequest.js';

const TOKEN_ID = 'd0c8b6a4-1e2f-4a3b-9c5d-8e7f6a5b4c31';

function enrollBody(): Record<string, unknown> {
  return {
    token: enrollmentToken(),
    hostname: 'WL-LAPTOP-014',
    os: 'windows',
    os_version: '10.0.22631',
    agent_version: '0.1.0',
    machine_fingerprint: 'e3b0c44298fc1c14',
  };
}

function request(body: Record<string, unknown> = enrollBody()) {
  return plainEvent({ method: 'POST', path: '/v1/device/enroll', body });
}

/** The token row the lookup returns, in whichever state the test needs. */
function tokenRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TOKEN_ID,
    org_id: ORG_ID,
    employee_id: EMPLOYEE_ID,
    expires_at: new Date('2026-08-20T00:00:00.000Z'),
    used_at: null,
    expired: false,
    ...overrides,
  };
}

/** Everything a successful enrolment needs beyond the token lookup. */
function mockSuccessfulWrites(): void {
  whenQuery(/^insert into devices/, (values) => [
    {
      id: values[0],
      employee_id: EMPLOYEE_ID,
      key_version: KEY_VERSION,
      enrolled_at: new Date('2026-08-18T12:00:00.000Z'),
    },
  ]);
  whenQuery(/^update enrollment_tokens/, [{ id: TOKEN_ID }]);
  whenQuery(/from monitoring_config/, [
    {
      org_id: ORG_ID,
      config_version: 3,
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
      excluded_apps: ['bankapp.exe'],
      excluded_url_patterns: ['*.bank.example'],
      retention_days_events: 90,
      retention_days_screenshots: 30,
    },
  ]);
}

beforeEach(() => {
  resetDb();
  installRootKeys();
});

afterEach(() => {
  clearRootKeys();
});

describe('enroll — token failures', () => {
  it('rejects a token that matches nothing with 401 INVALID_TOKEN', async () => {
    whenQuery(/from enrollment_tokens/, []);

    const response = await invoke(handler, request());

    expect(response.statusCode).toBe(401);
    expect(errorOf(response).code).toBe('INVALID_TOKEN');
    // Nothing was written: the lookup found no org to write into.
    expect(queriesMatching(/^insert into devices/)).toHaveLength(0);
    expect(txStats.rolledBack).toBe(1);
  });

  it('rejects an expired token with 410 and says so', async () => {
    whenQuery(/from enrollment_tokens/, [tokenRow({ expired: true })]);

    const response = await invoke(handler, request());

    expect(response.statusCode).toBe(410);
    expect(errorOf(response).code).toBe('ENROLLMENT_TOKEN_EXPIRED');
    expect(errorOf(response).message).toMatch(/expired/i);
    expect(queriesMatching(/^insert into devices/)).toHaveLength(0);
  });

  it('rejects an already-used token with 409 and does not create a second device', async () => {
    whenQuery(/from enrollment_tokens/, [
      tokenRow({ used_at: new Date('2026-08-17T09:00:00.000Z') }),
    ]);

    const response = await invoke(handler, request());

    expect(response.statusCode).toBe(409);
    expect(errorOf(response).code).toBe('ENROLLMENT_TOKEN_USED');
    expect(queriesMatching(/^insert into devices/)).toHaveLength(0);
  });

  it('loses the race when a concurrent enrolment consumed the token first', async () => {
    // The lookup saw the token unused — the concurrent enrolment committed after that snapshot.
    // The consuming UPDATE, which re-checks `used_at is null` against the committed row, matches
    // nothing.
    whenQuery(/from enrollment_tokens/, [tokenRow()]);
    mockSuccessfulWrites();
    whenQuery(/^update enrollment_tokens/, []);

    const response = await invoke(handler, request());

    expect(response.statusCode).toBe(409);
    expect(errorOf(response).code).toBe('ENROLLMENT_TOKEN_USED');
    // The device insert did run, and the rollback is what discards it. That is the whole point of
    // doing this inside a transaction: the loser leaves nothing behind.
    expect(queriesMatching(/^insert into devices/)).toHaveLength(1);
    expect(txStats.rolledBack).toBe(1);
    expect(txStats.committed).toBe(0);
  });

  it('consumes the token with a single-use predicate rather than a bare UPDATE', async () => {
    whenQuery(/from enrollment_tokens/, [tokenRow()]);
    mockSuccessfulWrites();

    await invoke(handler, request());

    const [consume] = queriesMatching(/^update enrollment_tokens/);
    expect(consume).toBeDefined();
    expect(consume?.sql).toContain('used_at is null');
    expect(consume?.sql).toContain('returning id');
  });
});

describe('enroll — success', () => {
  it('returns credentials, the org scope and the monitoring config', async () => {
    whenQuery(/from enrollment_tokens/, [tokenRow()]);
    mockSuccessfulWrites();

    const response = await invoke(handler, request());

    expect(response.statusCode).toBe(201);
    expect(response.body).toMatchObject({
      org_id: ORG_ID,
      employee_id: EMPLOYEE_ID,
      key_version: KEY_VERSION,
      config_version: 3,
    });
    expect(response.body.device_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(response.body.config).toMatchObject({
      screenshot_enabled: false,
      capture_urls: false,
      work_hours_only: true,
      excluded_apps: ['bankapp.exe'],
    });
    // A projection, not the row: org_id and config_version are not inside `config`.
    expect(response.body.config).not.toHaveProperty('org_id');
    expect(response.body.config).not.toHaveProperty('config_version');
    expect(txStats.committed).toBe(1);
  });

  it('returns the secret derived for this device, and stores nothing derived from it', async () => {
    whenQuery(/from enrollment_tokens/, [tokenRow()]);
    mockSuccessfulWrites();

    const response = await invoke(handler, request());
    const secret = response.body.device_secret;
    const deviceId = response.body.device_id as string;

    expect(typeof secret).toBe('string');
    expect(secret).toBe(deviceSecret(deviceId, ORG_ID));

    // The property that matters: no statement carried the secret, or any prefix of it, into the
    // database. A dump of `devices` yields no working credential (docs/PLAN.md deviation D4).
    const serialised = JSON.stringify(recorded);
    expect(serialised).not.toContain(secret as string);
    expect(serialised).not.toContain((secret as string).slice(0, 12));

    const [insert] = queriesMatching(/^insert into devices/);
    expect(insert?.sql).toContain('key_version');
    expect(insert?.sql).not.toMatch(/secret/i);
  });

  it('never sends the enrollment token to the database, only its digest', async () => {
    const body = enrollBody();
    whenQuery(/from enrollment_tokens/, [tokenRow()]);
    mockSuccessfulWrites();

    await invoke(handler, request(body));

    expect(JSON.stringify(recorded)).not.toContain(body.token as string);
    const [lookup] = queriesMatching(/from enrollment_tokens/);
    expect(lookup?.values[0]).toBeInstanceOf(Buffer);
    expect((lookup?.values[0] as Buffer).length).toBe(32);
  });

  it('records the enrolment in the audit log as a device actor', async () => {
    whenQuery(/from enrollment_tokens/, [tokenRow()]);
    mockSuccessfulWrites();

    const response = await invoke(handler, request());

    const [audit] = queriesMatching(/^insert into audit_log/);
    expect(audit).toBeDefined();
    expect(audit?.values).toContain('device.enrolled');
    expect(audit?.values).toContain('device');
    expect(audit?.values).toContain(`device:${response.body.device_id as string}`);
  });

  it('fails closed when the organisation has no monitoring_config row', async () => {
    whenQuery(/from enrollment_tokens/, [tokenRow()]);
    mockSuccessfulWrites();
    whenQuery(/from monitoring_config/, []);

    const response = await invoke(handler, request());

    // An agent must never invent its own collection settings, so this is a 500 rather than an
    // enrolment that succeeds with a guess.
    expect(response.statusCode).toBe(500);
    expect(errorOf(response).code).toBe('INTERNAL_ERROR');
    expect(txStats.committed).toBe(0);
  });
});

describe('enroll — request validation', () => {
  it('rejects a token that is not in wlen_ form before touching the database', async () => {
    const response = await invoke(handler, request({ ...enrollBody(), token: DEVICE_ID }));

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe('VALIDATION_FAILED');
    expect(errorOf(response).details?.[0]?.field).toBe('token');
    expect(recorded).toHaveLength(0);
  });

  it('rejects unknown keys rather than silently ignoring them', async () => {
    const response = await invoke(
      handler,
      request({ ...enrollBody(), keystrokes_enabled: true }),
    );

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).details?.[0]?.message).toMatch(/unrecognized key/i);
  });

  it('rejects a hostname that is only whitespace, as the CHECK constraint would', async () => {
    const response = await invoke(handler, request({ ...enrollBody(), hostname: '   ' }));

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).details?.[0]?.field).toBe('hostname');
  });

  it('rejects an unsupported operating system', async () => {
    const response = await invoke(handler, request({ ...enrollBody(), os: 'freebsd' }));

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).details?.[0]?.field).toBe('os');
  });
});
