/**
 * Tests for HMAC request signing.
 *
 * These are the tests that matter most in the repository: if this module is wrong, either
 * every agent is locked out, or anyone can forge a request. Each case below corresponds to
 * a specific attack or failure mode rather than to a line of code.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  canonicalRequest,
  extractHeaders,
  generateNonce,
  HEADER,
  sign,
  signaturesMatch,
  verify,
} from '../../src/shared/signature.js';

const SECRET = 'dGVzdC1zZWNyZXQtbm90LWEtcmVhbC1kZXZpY2Utc2VjcmV0';
const NONCE = '0123456789abcdef0123456789abcdef';
const NOW = 1_760_000_000;

function baseParts(overrides: Partial<Parameters<typeof sign>[1]> = {}) {
  return {
    method: 'POST',
    path: '/v1/device/events',
    timestamp: NOW,
    nonce: NONCE,
    body: '{"events":[]}',
    ...overrides,
  };
}

function verifyWith(
  overrides: Partial<Parameters<typeof verify>[0]> = {},
  partOverrides: Parameters<typeof baseParts>[0] = {},
) {
  const parts = baseParts(partOverrides);
  return verify({
    ...parts,
    secret: SECRET,
    providedSignature: sign(SECRET, parts),
    windowSeconds: 300,
    nowSeconds: NOW,
    ...overrides,
  });
}

describe('canonicalRequest', () => {
  it('joins the five fields with newlines and hashes the body', () => {
    const body = JSON.stringify({ window_title: 'Quarterly board pack — Chrome' });
    const canonical = canonicalRequest(baseParts({ body }));
    const lines = canonical.split('\n');

    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('POST');
    expect(lines[1]).toBe('/v1/device/events');
    expect(lines[2]).toBe(String(NOW));
    expect(lines[3]).toBe(NONCE);
    // The body appears only as a hash. It matters that the canonical string cannot leak a
    // window title into anything that logs or echoes it.
    expect(lines[4]).toMatch(/^[0-9a-f]{64}$/);
    expect(canonical).not.toContain('Quarterly board pack');
  });

  it('upper-cases the method so a lower-case verb still verifies', () => {
    expect(canonicalRequest(baseParts({ method: 'post' }))).toBe(
      canonicalRequest(baseParts({ method: 'POST' })),
    );
  });

  it('does not normalise the path — agent and server must agree byte for byte', () => {
    // If this ever starts passing, someone has added normalisation and the Go agent's
    // implementation has to match it exactly. That is a coupling worth failing over.
    expect(canonicalRequest(baseParts({ path: '/v1/device/events/' }))).not.toBe(
      canonicalRequest(baseParts({ path: '/v1/device/events' })),
    );
  });

  it('is deterministic', () => {
    expect(sign(SECRET, baseParts())).toBe(sign(SECRET, baseParts()));
  });
});

describe('verify — the happy path', () => {
  it('accepts a correctly signed request', () => {
    expect(verifyWith()).toEqual({ ok: true });
  });

  it('accepts an empty body', () => {
    expect(verifyWith({}, { body: '' })).toEqual({ ok: true });
  });

  it('accepts a request at the exact edge of the window, in both directions', () => {
    expect(verifyWith({ nowSeconds: NOW + 300 })).toEqual({ ok: true });
    expect(verifyWith({ nowSeconds: NOW - 300 })).toEqual({ ok: true });
  });
});

describe('verify — forgery and tampering', () => {
  it('rejects a body that was changed after signing', () => {
    const parts = baseParts();
    const signature = sign(SECRET, parts);

    // The attacker keeps the signature and swaps the payload. This is the case a bearer
    // token cannot defend against at all.
    const result = verify({
      ...parts,
      body: '{"events":[{"app_name":"forged.exe"}]}',
      secret: SECRET,
      providedSignature: signature,
      windowSeconds: 300,
      nowSeconds: NOW,
    });

    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects a signature captured from a different route', () => {
    // Signed for GET /v1/device/config, replayed against POST /v1/device/events. Both have
    // an empty body, so without METHOD and PATH in the canonical form this would succeed.
    const signed = baseParts({ method: 'GET', path: '/v1/device/config', body: '' });
    const signature = sign(SECRET, signed);

    const result = verify({
      ...baseParts({ method: 'POST', path: '/v1/device/events', body: '' }),
      secret: SECRET,
      providedSignature: signature,
      windowSeconds: 300,
      nowSeconds: NOW,
    });

    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects a signature made with a different secret', () => {
    const parts = baseParts();
    const result = verify({
      ...parts,
      secret: SECRET,
      providedSignature: sign('a-different-device-secret', parts),
      windowSeconds: 300,
      nowSeconds: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects a signature whose nonce was swapped', () => {
    const parts = baseParts();
    const signature = sign(SECRET, parts);
    const result = verify({
      ...parts,
      nonce: 'ffffffffffffffffffffffffffffffff',
      secret: SECRET,
      providedSignature: signature,
      windowSeconds: 300,
      nowSeconds: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects a signature whose timestamp was moved forward to dodge expiry', () => {
    const original = baseParts({ timestamp: NOW - 10_000 });
    const signature = sign(SECRET, original);

    // Presenting a fresh timestamp with the old signature: the timestamp is inside the
    // signed material, so this cannot work.
    const result = verify({
      ...baseParts({ timestamp: NOW }),
      secret: SECRET,
      providedSignature: signature,
      windowSeconds: 300,
      nowSeconds: NOW,
    });

    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
  });
});

describe('verify — clock skew', () => {
  it('reports a stale timestamp distinctly from a bad signature', () => {
    const result = verifyWith({ nowSeconds: NOW + 4000 });
    // Distinguishing these is deliberate: a laptop with a wrong clock is a support call,
    // and `agentctl doctor` reports the skew rather than "authentication failed".
    expect(result).toEqual({ ok: false, reason: 'timestamp_out_of_window', skewSeconds: 4000 });
  });

  it('reports a future timestamp with a negative skew', () => {
    const result = verifyWith({ nowSeconds: NOW - 4000 });
    expect(result).toEqual({ ok: false, reason: 'timestamp_out_of_window', skewSeconds: -4000 });
  });

  it('checks the window before the HMAC, so skew is reported even with a bad signature', () => {
    const result = verify({
      ...baseParts(),
      secret: SECRET,
      providedSignature: 'f'.repeat(64),
      windowSeconds: 300,
      nowSeconds: NOW + 4000,
    });
    expect(result).toEqual({ ok: false, reason: 'timestamp_out_of_window', skewSeconds: 4000 });
  });
});

describe('verify — malformed input', () => {
  it.each([
    ['too short', 'abc'],
    ['too long', `${NONCE}00`],
    ['not hex', 'ZZZ456789abcdef0123456789abcdef0'],
    ['upper case hex', NONCE.toUpperCase()],
    ['empty', ''],
  ])('rejects a nonce that is %s', (_label, nonce) => {
    expect(verifyWith({ nonce }, { nonce })).toEqual({ ok: false, reason: 'malformed_nonce' });
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
  ])('rejects a timestamp that is %s', (_label, timestamp) => {
    expect(verifyWith({ timestamp }, { timestamp })).toEqual({
      ok: false,
      reason: 'malformed_timestamp',
    });
  });

  it.each([
    ['too short', 'abcd'],
    ['too long', `${'a'.repeat(65)}`],
    ['not hex', 'g'.repeat(64)],
    ['empty', ''],
  ])('rejects a signature that is %s', (_label, providedSignature) => {
    expect(verifyWith({ providedSignature })).toEqual({
      ok: false,
      reason: 'malformed_signature',
    });
  });
});

describe('signaturesMatch', () => {
  it('accepts identical signatures', () => {
    const value = createHmac('sha256', 'k').update('m').digest('hex');
    expect(signaturesMatch(value, value)).toBe(true);
  });

  it('rejects a signature differing in one nibble', () => {
    const value = createHmac('sha256', 'k').update('m').digest('hex');
    const flipped = `${value.slice(0, -1)}${value.endsWith('0') ? '1' : '0'}`;
    expect(signaturesMatch(value, flipped)).toBe(false);
  });

  it('rejects a length mismatch instead of throwing', () => {
    // timingSafeEqual throws on unequal lengths; a length check has to come first or a
    // short signature crashes the handler into a 500 rather than a clean 401.
    const value = createHmac('sha256', 'k').update('m').digest('hex');
    expect(() => signaturesMatch(value, 'abc')).not.toThrow();
    expect(signaturesMatch(value, 'abc')).toBe(false);
  });

  it('rejects non-hex of the right length', () => {
    expect(signaturesMatch('a'.repeat(64), 'z'.repeat(64))).toBe(false);
  });
});

describe('generateNonce', () => {
  it('produces 32 lower-case hex characters', () => {
    expect(generateNonce()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('does not repeat across many calls', () => {
    const seen = new Set(Array.from({ length: 2000 }, () => generateNonce()));
    expect(seen.size).toBe(2000);
  });
});

describe('extractHeaders', () => {
  const complete = {
    [HEADER.device]: '6a5b2a91-41c3-47b4-8976-06455fbfc12b',
    [HEADER.timestamp]: String(NOW),
    [HEADER.nonce]: NONCE,
    [HEADER.signature]: 'a'.repeat(64),
  };

  it('extracts all four headers', () => {
    expect(extractHeaders(complete)).toEqual({
      deviceId: '6a5b2a91-41c3-47b4-8976-06455fbfc12b',
      timestamp: NOW,
      nonce: NONCE,
      signature: 'a'.repeat(64),
    });
  });

  it('is case-insensitive, because gateways and clients differ on casing', () => {
    const mixed = {
      'X-WL-Device': complete[HEADER.device],
      'X-Wl-Timestamp': complete[HEADER.timestamp],
      'x-wl-NONCE': complete[HEADER.nonce],
      'X-WL-SIGNATURE': complete[HEADER.signature],
    };
    expect(extractHeaders(mixed)?.nonce).toBe(NONCE);
  });

  it.each(Object.values(HEADER))('returns null when %s is missing', (missing) => {
    const partial: Record<string, string | undefined> = { ...complete };
    delete partial[missing];
    expect(extractHeaders(partial)).toBeNull();
  });

  it('returns null when a header is present but undefined', () => {
    expect(extractHeaders({ ...complete, [HEADER.nonce]: undefined })).toBeNull();
  });

  it('turns a non-numeric timestamp into NaN for verify to reject', () => {
    const result = extractHeaders({ ...complete, [HEADER.timestamp]: 'not-a-number' });
    expect(result?.timestamp).toBeNaN();
  });

  it('turns an absurdly long timestamp into NaN rather than a huge number', () => {
    const result = extractHeaders({ ...complete, [HEADER.timestamp]: '9'.repeat(40) });
    expect(result?.timestamp).toBeNaN();
  });
});

describe('cross-implementation contract', () => {
  it('matches a hand-computed HMAC', () => {
    // Built from primitives rather than from canonicalRequest(), so a refactor that
    // changed the canonical form on both sides at once would still be caught here. The Go
    // agent is checked against this same construction.
    const parts = baseParts();
    const expectedCanonical = [
      'POST',
      '/v1/device/events',
      String(NOW),
      NONCE,
      createHash('sha256').update('{"events":[]}', 'utf8').digest('hex'),
    ].join('\n');

    const expected = createHmac('sha256', SECRET).update(expectedCanonical, 'utf8').digest('hex');
    expect(sign(SECRET, parts)).toBe(expected);
  });

  it('signs a body containing multi-byte characters consistently', () => {
    // Window titles routinely contain non-ASCII. If the agent hashed UTF-8 bytes and the
    // server hashed something else, every such request would fail authentication.
    const body = JSON.stringify({ window_title: 'Rapport trimestriel — Übersicht — 日本語' });
    const parts = baseParts({ body });
    expect(
      verify({
        ...parts,
        secret: SECRET,
        providedSignature: sign(SECRET, parts),
        windowSeconds: 300,
        nowSeconds: NOW,
      }),
    ).toEqual({ ok: true });
  });

  it('uses a 128-bit nonce', () => {
    expect(randomBytes(16)).toHaveLength(16);
    expect(generateNonce()).toHaveLength(32);
  });
});
