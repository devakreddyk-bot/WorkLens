/**
 * `POST /v1/device/screenshots` and its `/complete` counterpart.
 *
 * The presign test asserts against the *signed* URL rather than against the arguments passed to
 * the SDK, because what matters is not that the handler asked for constraints — it is that the
 * constraints ended up inside `X-Amz-SignedHeaders`, where S3 will enforce them. Those two
 * things came apart during development in two separate ways (the presigner marks `content-type`
 * unsignable by default, and the SDK signs a CRC32 of the empty request body unless told not
 * to), and neither is visible from the call site. Signing for real, with fake credentials from
 * `test/setup.ts`, is what catches them.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/shared/db.js', async (importOriginal) =>
  (await import('../helpers/dbMock.js')).dbMockFactory(importOriginal),
);

import { handler as completeHandler } from '../../src/handlers/device/screenshotComplete.js';
import { handler as presignHandler } from '../../src/handlers/device/screenshotPresign.js';
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

const SCREENSHOT_ID = 'c3d5e7f9-1a2b-4c3d-8e5f-6a7b8c9d0e1f';
const SHA256 = 'a'.repeat(64);

function mockMonitoringConfig(screenshotEnabled: boolean): void {
  whenQuery(/from monitoring_config/, [
    {
      org_id: ORG_ID,
      config_version: 4,
      sample_interval_seconds: 60,
      idle_threshold_seconds: 300,
      capture_window_titles: true,
      capture_urls: false,
      screenshot_enabled: screenshotEnabled,
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
    },
  ]);
}

function presignBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    captured_at: '2026-08-18T09:45:00.000Z',
    width: 1920,
    height: 1080,
    byte_count: 145_223,
    sha256: SHA256,
    blurred: true,
    ...overrides,
  };
}

function presignRequest(body: Record<string, unknown> = presignBody()) {
  return signedEvent({ method: 'POST', path: '/v1/device/screenshots', body });
}

function completeRequest(screenshotId = SCREENSHOT_ID) {
  return signedEvent({
    method: 'POST',
    path: `/v1/device/screenshots/${screenshotId}/complete`,
    pathParameters: { id: screenshotId },
  });
}

function screenshotRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SCREENSHOT_ID,
    employee_id: EMPLOYEE_ID,
    device_id: DEVICE_ID,
    captured_at: new Date('2026-08-18T09:45:00.000Z'),
    s3_bucket: config.SCREENSHOT_BUCKET,
    s3_key: `screenshots/${ORG_ID}/${EMPLOYEE_ID}/2026/08/18/${SCREENSHOT_ID}.png`,
    content_type: 'image/png',
    byte_count: 145_223,
    upload_state: 'pending',
    uploaded_at: null,
    ...overrides,
  };
}

/** The signed-header list S3 will hold the uploader to. */
function signedHeaders(url: string): string[] {
  const value = new URL(url).searchParams.get('X-Amz-SignedHeaders') ?? '';
  return value.split(';').filter((header) => header !== '');
}

beforeEach(() => {
  resetDb();
  installRootKeys();
  mockDeviceRow();
});

afterEach(() => {
  clearRootKeys();
});

describe('screenshot presign — the feature switch', () => {
  it('refuses with 403 FEATURE_DISABLED when the org has screenshots off', async () => {
    mockMonitoringConfig(false);

    const response = await invoke(presignHandler, presignRequest());

    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('FEATURE_DISABLED');
    // Refused before a row was written or a URL minted, so a tampered agent gains nothing.
    expect(queriesMatching(/^insert into screenshots/)).toHaveLength(0);
  });

  it('checks the switch before validating the payload', async () => {
    mockMonitoringConfig(false);

    // A payload that would also fail validation still gets the feature answer, because the
    // organisation's decision is the more important fact to report.
    const response = await invoke(presignHandler, presignRequest(presignBody({ width: 0 })));

    expect(errorOf(response).code).toBe('FEATURE_DISABLED');
  });
});

describe('screenshot presign — size', () => {
  beforeEach(() => {
    mockMonitoringConfig(true);
  });

  it('rejects a byte_count over MAX_SCREENSHOT_BYTES with 400 naming the field', async () => {
    const response = await invoke(
      presignHandler,
      presignRequest(presignBody({ byte_count: config.MAX_SCREENSHOT_BYTES + 1 })),
    );

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe('VALIDATION_FAILED');
    expect(errorOf(response).details?.[0]?.field).toBe('byte_count');
    expect(errorOf(response).details?.[0]?.message).toContain('MAX_SCREENSHOT_BYTES');
  });

  it('rejects a zero-byte screenshot', async () => {
    const response = await invoke(
      presignHandler,
      presignRequest(presignBody({ byte_count: 0 })),
    );

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).details?.[0]?.field).toBe('byte_count');
  });

  it('rejects a digest that is not 64 hex characters', async () => {
    const response = await invoke(
      presignHandler,
      presignRequest(presignBody({ sha256: 'not-a-digest' })),
    );

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).details?.[0]?.field).toBe('sha256');
  });
});

describe('screenshot presign — the URL is constrained, not merely requested', () => {
  beforeEach(() => {
    mockMonitoringConfig(true);
    whenQuery(/^insert into screenshots/, (values) => [screenshotRow({ id: values[0] })]);
  });

  it('signs over SSE-KMS, so the URL cannot write an unencrypted object', async () => {
    const response = await invoke(presignHandler, presignRequest());

    expect(response.statusCode).toBe(201);
    const headers = signedHeaders(response.body.upload_url as string);
    expect(headers).toContain('x-amz-server-side-encryption');
    expect(headers).toContain('x-amz-server-side-encryption-aws-kms-key-id');
  });

  it('signs over content-length and content-type, so the URL cannot upload something else', async () => {
    const response = await invoke(presignHandler, presignRequest());

    const headers = signedHeaders(response.body.upload_url as string);
    expect(headers).toContain('content-length');
    expect(headers).toContain('content-type');
  });

  it('tells the agent exactly which headers the signature covers', async () => {
    const response = await invoke(presignHandler, presignRequest());

    expect(response.body.required_headers).toEqual({
      'content-length': '145223',
      'content-type': 'image/png',
      'x-amz-server-side-encryption': 'aws:kms',
      'x-amz-server-side-encryption-aws-kms-key-id': config.S3_KMS_KEY_ARN,
    });

    // Every header named as required is actually in the signature; otherwise the contract would
    // be advice rather than a contract.
    const headers = signedHeaders(response.body.upload_url as string);
    for (const name of Object.keys(response.body.required_headers as Record<string, string>)) {
      expect(headers).toContain(name);
    }
  });

  it('does not sign a checksum of the empty request body', async () => {
    const response = await invoke(presignHandler, presignRequest());

    // Left at the SDK default, a CRC32 of the (absent) body is computed and signed into the URL,
    // and every real upload through it then fails with a checksum mismatch.
    const url = new URL(response.body.upload_url as string);
    expect([...url.searchParams.keys()].filter((key) => key.includes('checksum'))).toEqual([]);
  });

  it('expires the URL at the configured lifetime', async () => {
    const response = await invoke(presignHandler, presignRequest());

    const url = new URL(response.body.upload_url as string);
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(config.PRESIGN_EXPIRY_SECONDS));
    expect(response.body.expires_in_seconds).toBe(config.PRESIGN_EXPIRY_SECONDS);
  });

  it('writes the pending row before issuing the URL, with the digest as raw bytes', async () => {
    const response = await invoke(presignHandler, presignRequest());

    const [insert] = queriesMatching(/^insert into screenshots/);
    expect(insert?.sql).toContain("'pending'");
    expect(insert?.values[0]).toBe(response.body.screenshot_id);
    expect(insert?.values[1]).toBe(ORG_ID);
    expect(insert?.values[2]).toBe(EMPLOYEE_ID);
    expect(insert?.values[3]).toBe(DEVICE_ID);

    const digest = insert?.values[11];
    expect(digest).toBeInstanceOf(Buffer);
    expect((digest as Buffer).length).toBe(32);
  });

  it('keys the object under the org, the employee and the capture date', async () => {
    const response = await invoke(presignHandler, presignRequest());

    expect(response.body.s3_key).toBe(
      `${config.SCREENSHOT_PREFIX}${ORG_ID}/${EMPLOYEE_ID}/2026/08/18/` +
        `${response.body.screenshot_id as string}.png`,
    );
    expect(response.body.s3_bucket).toBe(config.SCREENSHOT_BUCKET);
  });

  it('refuses a device whose notice was never acknowledged', async () => {
    resetDb();
    mockDeviceRow({ noticeAcknowledgedAt: null });
    mockMonitoringConfig(true);

    const response = await invoke(presignHandler, presignRequest());

    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('FORBIDDEN');
    expect(queriesMatching(/^insert into screenshots/)).toHaveLength(0);
  });
});

describe('screenshot complete', () => {
  it('flips a pending row to uploaded', async () => {
    whenQuery(/^update screenshots/, [
      {
        ...screenshotRow(),
        upload_state: 'uploaded',
        uploaded_at: new Date('2026-08-18T09:46:00.000Z'),
      },
    ]);

    const response = await invoke(completeHandler, completeRequest());

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      screenshot_id: SCREENSHOT_ID,
      upload_state: 'uploaded',
      uploaded_at: '2026-08-18T09:46:00.000Z',
    });
  });

  it('scopes the update to the calling device, not just the organisation', async () => {
    whenQuery(/^update screenshots/, [screenshotRow({ upload_state: 'uploaded' })]);

    await invoke(completeHandler, completeRequest());

    const [update] = queriesMatching(/^update screenshots/);
    expect(update?.values).toEqual([ORG_ID, DEVICE_ID, SCREENSHOT_ID]);
    expect(update?.sql).toContain('uploaded_at = coalesce(uploaded_at, now())');
  });

  it('returns 404 for a screenshot this device does not own', async () => {
    whenQuery(/^update screenshots/, []);
    whenQuery(/from screenshots where/, []);

    const response = await invoke(completeHandler, completeRequest());

    expect(response.statusCode).toBe(404);
    expect(errorOf(response).code).toBe('NOT_FOUND');
  });

  it('returns 409 for a row the retention sweeper already expired', async () => {
    whenQuery(/^update screenshots/, []);
    whenQuery(/from screenshots where/, [screenshotRow({ upload_state: 'expired' })]);

    const response = await invoke(completeHandler, completeRequest());

    expect(response.statusCode).toBe(409);
    expect(errorOf(response).code).toBe('CONFLICT');
    expect(errorOf(response).message).toMatch(/expired/i);
  });

  it('returns 404 for a malformed id without asking the database to cast it', async () => {
    const response = await invoke(completeHandler, completeRequest('not-a-uuid'));

    expect(response.statusCode).toBe(404);
    expect(queriesMatching(/screenshots/)).toHaveLength(0);
  });

  it('rejects a body on a route that takes none', async () => {
    const event = signedEvent({
      method: 'POST',
      path: `/v1/device/screenshots/${SCREENSHOT_ID}/complete`,
      pathParameters: { id: SCREENSHOT_ID },
      body: { byte_count: 145_223 },
    });

    const response = await invoke(completeHandler, event);

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).details?.[0]?.message).toMatch(/unrecognized key/i);
  });
});
