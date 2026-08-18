/**
 * `GET /v1/device/config` and `POST /v1/device/heartbeat`.
 *
 * Both are ungated on purpose, and both tests below pin that: an agent has to be able to fetch the
 * exclusion rules and report itself alive *before* anybody has acknowledged the first-run notice —
 * a laptop stuck on that screen is exactly the situation an operator needs to be able to see.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/shared/db.js', async (importOriginal) =>
  (await import('../helpers/dbMock.js')).dbMockFactory(importOriginal),
);

import { handler as configHandler } from '../../src/handlers/device/config.js';
import { handler as heartbeatHandler } from '../../src/handlers/device/heartbeat.js';
import { queriesMatching, resetDb, whenQuery } from '../helpers/dbMock.js';
import {
  DEVICE_ID,
  ORG_ID,
  clearRootKeys,
  errorOf,
  installRootKeys,
  invoke,
  mockDeviceRow,
  signedEvent,
} from '../helpers/deviceRequest.js';

const LAST_SEEN = new Date('2026-08-18T09:50:00.000Z');

function mockMonitoringConfig(): void {
  whenQuery(/from monitoring_config/, [
    {
      org_id: ORG_ID,
      config_version: 7,
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
      excluded_url_patterns: ['*.bank.example', '*.health.example'],
      retention_days_events: 90,
      retention_days_screenshots: 30,
    },
  ]);
}

function deviceStateRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: DEVICE_ID,
    employee_id: '7c9e2b18-4d5a-4c6b-8e21-3f0a9d7b6c55',
    key_version: 1,
    last_seen_at: LAST_SEEN,
    last_config_fetch_at: LAST_SEEN,
    notice_acknowledged_at: new Date('2026-05-01T08:00:00.000Z'),
    revoked_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  resetDb();
  installRootKeys();
  mockDeviceRow();
});

afterEach(() => {
  clearRootKeys();
});

describe('device config', () => {
  beforeEach(() => {
    mockMonitoringConfig();
    whenQuery(/last_config_fetch_at = now\(\)/, [deviceStateRow()]);
  });

  it('returns the config and its version', async () => {
    const response = await invoke(
      configHandler,
      signedEvent({ method: 'GET', path: '/v1/device/config' }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.config_version).toBe(7);
    expect(response.body.config).toEqual({
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
      excluded_url_patterns: ['*.bank.example', '*.health.example'],
      retention_days_events: 90,
      retention_days_screenshots: 30,
    });
  });

  it('records the fetch, and counts it as liveness', async () => {
    await invoke(configHandler, signedEvent({ method: 'GET', path: '/v1/device/config' }));

    const [touch] = queriesMatching(/last_config_fetch_at = now\(\)/);
    expect(touch?.sql).toContain('last_seen_at = now()');
    expect(touch?.values).toEqual([ORG_ID, DEVICE_ID, null]);
  });

  it('serves a device that has not yet acknowledged the notice', async () => {
    resetDb();
    mockDeviceRow({ noticeAcknowledgedAt: null });
    mockMonitoringConfig();
    whenQuery(/last_config_fetch_at = now\(\)/, [deviceStateRow({ notice_acknowledged_at: null })]);

    const response = await invoke(
      configHandler,
      signedEvent({ method: 'GET', path: '/v1/device/config' }),
    );

    // The agent needs the exclusion rules and the work-hours window to behave correctly from its
    // very first sample, and the notice screen it shows is part of that same first run.
    expect(response.statusCode).toBe(200);
  });

  it('fails closed when the organisation has no monitoring_config row', async () => {
    resetDb();
    mockDeviceRow();
    whenQuery(/from monitoring_config/, []);

    const response = await invoke(
      configHandler,
      signedEvent({ method: 'GET', path: '/v1/device/config' }),
    );

    expect(response.statusCode).toBe(500);
    // An agent with no configuration must not fall back to defaults of its own choosing, so the
    // fetch is not recorded as successful either.
    expect(queriesMatching(/last_config_fetch_at = now\(\)/)).toHaveLength(0);
  });
});

describe('heartbeat', () => {
  it('records liveness and the reported agent version', async () => {
    whenQuery(/^update devices set last_seen_at = now\(\)/, [deviceStateRow()]);

    const response = await invoke(
      heartbeatHandler,
      signedEvent({
        method: 'POST',
        path: '/v1/device/heartbeat',
        body: { agent_version: '0.2.0', os_version: '10.0.22631' },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      device_id: DEVICE_ID,
      last_seen_at: LAST_SEEN.toISOString(),
      notice_acknowledged: true,
    });

    const [touch] = queriesMatching(/^update devices set last_seen_at = now\(\)/);
    expect(touch?.values).toEqual([ORG_ID, DEVICE_ID, '0.2.0', '10.0.22631']);
    // coalesce, so a heartbeat that omits a version does not blank one an earlier request set.
    expect(touch?.sql).toContain('agent_version = coalesce($3, agent_version)');
  });

  it('accepts health counters without a column to put them in', async () => {
    whenQuery(/^update devices set last_seen_at = now\(\)/, [deviceStateRow()]);

    const response = await invoke(
      heartbeatHandler,
      signedEvent({
        method: 'POST',
        path: '/v1/device/heartbeat',
        body: {
          agent_version: '0.2.0',
          health: {
            buffered_events: 1450,
            queued_screenshots: 0,
            upload_failures: 3,
            dropped_events: 0,
            uptime_seconds: 86_400,
            last_error_code: 'upload_timeout',
          },
        },
      }),
    );

    expect(response.statusCode).toBe(200);
    // `devices` has no health columns, and inventing one is not this handler's call. The counters
    // go to the log, where a metric filter can reach them.
    const touch = queriesMatching(/^update devices set last_seen_at = now\(\)/)[0];
    expect(JSON.stringify(touch?.values)).not.toContain('1450');
  });

  it('rejects an error message where a symbolic code belongs', async () => {
    const response = await invoke(
      heartbeatHandler,
      signedEvent({
        method: 'POST',
        path: '/v1/device/heartbeat',
        body: { health: { last_error_code: 'failed to capture "Statement — HDFC Bank"' } },
      }),
    );

    // A capture error's message can contain the window title that caused it, which must not reach
    // CloudWatch under a retention policy the organisation never agreed to.
    expect(response.statusCode).toBe(400);
    expect(errorOf(response).details?.[0]?.field).toBe('health.last_error_code');
  });

  it('accepts an empty body', async () => {
    whenQuery(/^update devices set last_seen_at = now\(\)/, [deviceStateRow()]);

    const response = await invoke(
      heartbeatHandler,
      signedEvent({ method: 'POST', path: '/v1/device/heartbeat' }),
    );

    expect(response.statusCode).toBe(200);
  });

  it('reports a device whose notice is still outstanding rather than refusing it', async () => {
    resetDb();
    mockDeviceRow({ noticeAcknowledgedAt: null });
    whenQuery(/^update devices set last_seen_at = now\(\)/, [
      deviceStateRow({ notice_acknowledged_at: null }),
    ]);

    const response = await invoke(
      heartbeatHandler,
      signedEvent({ method: 'POST', path: '/v1/device/heartbeat' }),
    );

    // A laptop stuck on the first-run screen has to stay visible in the dashboard, which is why
    // this route is not behind the notice gate.
    expect(response.statusCode).toBe(200);
    expect(response.body.notice_acknowledged).toBe(false);
  });

  it('refuses a replayed request', async () => {
    whenQuery(/^update devices set last_seen_at = now\(\)/, [deviceStateRow()]);
    // The nonce insert hitting the primary key is how a replay is detected.
    whenQuery(/^insert into device_nonces/, () => {
      throw Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
      });
    });

    const response = await invoke(
      heartbeatHandler,
      signedEvent({ method: 'POST', path: '/v1/device/heartbeat' }),
    );

    expect(response.statusCode).toBe(401);
    expect(errorOf(response).code).toBe('REPLAYED_REQUEST');
  });

  it('tells a device with a wrong clock that its clock is wrong', async () => {
    const response = await invoke(
      heartbeatHandler,
      signedEvent({
        method: 'POST',
        path: '/v1/device/heartbeat',
        timestamp: Math.floor(Date.now() / 1000) - 4000,
      }),
    );

    expect(response.statusCode).toBe(401);
    expect(errorOf(response).code).toBe('TIMESTAMP_OUT_OF_WINDOW');
    expect(errorOf(response).message).toMatch(/device clock/);
  });
});
