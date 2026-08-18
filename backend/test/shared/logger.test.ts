/**
 * Tests for log redaction.
 *
 * Redaction is a privacy control, not a convenience. A logger that silently stopped
 * redacting would keep working perfectly and quietly copy device secrets and window titles
 * into CloudWatch, so it needs the same kind of adversarial test as the crypto.
 */

import { describe, expect, it } from 'vitest';

import { redactForTest } from '../../src/shared/logger.js';

/** Distinctive enough that a substring search over the whole output is meaningful. */
const SECRET = 'kJ8sQ2-DEVICE-SECRET-MUST-NEVER-APPEAR-9xTz';
const TITLE = 'Oncology results — Patient 4471 — Chrome';

function serialise(value: unknown): string {
  return JSON.stringify(redactForTest(value));
}

describe('credential redaction', () => {
  it.each([
    'device_secret',
    'deviceSecret',
    'DEVICE_SECRET',
    'secret',
    'password',
    'db_password',
    'token',
    'enrollmentToken',
    'refresh_token',
    'credential',
    'authorization',
    'Authorization',
    'signature',
    'x_wl_signature',
    'apiKey',
    'api_key',
    'private_key',
    'rootKey',
    'root_key',
    'cookie',
    'session_id',
  ])('redacts a field named %s', (key) => {
    const output = serialise({ [key]: SECRET });
    expect(output).not.toContain(SECRET);
    expect(output).toContain('[redacted]');
  });

  it('redacts at depth', () => {
    const output = serialise({
      request: { device: { credentials: { device_secret: SECRET } } },
    });
    expect(output).not.toContain(SECRET);
  });

  it('redacts inside arrays', () => {
    expect(serialise({ devices: [{ token: SECRET }, { token: SECRET }] })).not.toContain(SECRET);
  });

  it('redacts inside an Error cause chain', () => {
    const inner = new Error('inner');
    // A common real shape: an error carrying the failing context as a cause.
    const outer = new Error('enrolment failed', { cause: { device_secret: SECRET, inner } });
    expect(serialise({ err: outer })).not.toContain(SECRET);
  });

  it('never logs buffer contents, because key material travels as a Buffer', () => {
    // A neutral key name on purpose: `rootKeyMaterial` would be caught by the key-name
    // rule before the value was ever inspected, so it would not exercise this path. The
    // guarantee under test is that Buffer *contents* are never rendered regardless of what
    // the field is called.
    const output = serialise({ payload: Buffer.from(SECRET, 'utf8') });
    expect(output).not.toContain(SECRET);
    expect(output).toContain('bytes');
  });

  it('redacts a buffer by key name as well, before even looking at the value', () => {
    expect(serialise({ rootKeyMaterial: Buffer.from(SECRET, 'utf8') })).toBe(
      '{"rootKeyMaterial":"[redacted]"}',
    );
  });

  it('leaves non-sensitive fields intact, or the logs would be useless', () => {
    const output = serialise({
      deviceId: '9a594a02-afe7-4537-b57a-f771875c3c87',
      orgId: '3f7a1c0e-2b4d-4f6a-8c1e-9d0b5a7e3c11',
      status: 200,
      durationMs: 42,
      accepted: 17,
    });
    expect(output).toContain('9a594a02-afe7-4537-b57a-f771875c3c87');
    expect(output).toContain('42');
  });
});

describe('personal-data redaction', () => {
  // LOG_REQUEST_BODIES is 0 in test/setup.ts, matching production.
  it.each(['window_title', 'windowTitle', 'url_title', 'urlTitle', 'page_title'])(
    'redacts %s when request-body logging is off',
    (key) => {
      const output = serialise({ [key]: TITLE });
      expect(output).not.toContain('Patient 4471');
      expect(output).toContain('[redacted:personal-data]');
    },
  );

  it('distinguishes personal data from credentials in the output', () => {
    const output = serialise({ device_secret: SECRET, window_title: TITLE });
    // Two different markers, because the reasons differ and so does the remedy: one is
    // never loggable, the other is loggable in a non-production environment.
    expect(output).toContain('[redacted]');
    expect(output).toContain('[redacted:personal-data]');
  });
});

describe('robustness', () => {
  it('does not hang on a circular structure', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;
    expect(serialise(node)).toContain('[circular]');
  });

  it('stops at a depth limit rather than recursing without bound', () => {
    let deep: Record<string, unknown> = { value: 'bottom' };
    for (let i = 0; i < 40; i += 1) deep = { child: deep };
    expect(serialise(deep)).toContain('[max depth]');
  });

  it('truncates a very long string', () => {
    const output = serialise({ note: 'x'.repeat(5000) });
    expect(output).toContain('truncated');
    expect(output.length).toBeLessThan(3000);
  });

  it('caps a very long array', () => {
    const output = serialise({ events: Array.from({ length: 500 }, (_, i) => i) });
    expect(output).toContain('more');
  });

  it('handles null, undefined and primitives without throwing', () => {
    expect(redactForTest(null)).toBeNull();
    expect(redactForTest(undefined)).toBeUndefined();
    expect(redactForTest(42)).toBe(42);
    expect(redactForTest(true)).toBe(true);
    expect(redactForTest(10n)).toBe('10');
  });

  it('renders a Date as an ISO string', () => {
    expect(redactForTest(new Date('2026-08-18T12:00:00.000Z'))).toBe('2026-08-18T12:00:00.000Z');
  });

  it('does not serialise a function', () => {
    expect(serialise({ callback: () => undefined })).toContain('function');
  });

  it('keeps an error message and stack, which is the point of logging one', () => {
    const output = serialise({ err: new Error('connection refused') });
    expect(output).toContain('connection refused');
    expect(output).toContain('stack');
  });
});
