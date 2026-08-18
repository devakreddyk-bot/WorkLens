/**
 * HMAC request signing for the device API (docs/PLAN.md deviation D3).
 *
 * A bearer token is replayable: capture one request and it can be resent until the token
 * expires, and shortening expiry forces a refresh dance into an agent that is frequently
 * offline. Signing each request instead authenticates the device *and* the body, and
 * bounds replay to a few minutes.
 *
 * The wire format:
 *
 *     X-WL-Device:    <device uuid>
 *     X-WL-Timestamp: <unix seconds>
 *     X-WL-Nonce:     <32 hex chars — 128 bits from a CSPRNG>
 *     X-WL-Signature: <64 hex chars — HMAC-SHA256 over the canonical request>
 *
 *     canonical = METHOD \n PATH \n TIMESTAMP \n NONCE \n hex(sha256(BODY))
 *
 * Every element earns its place:
 *
 *  - **METHOD and PATH** stop a signature captured from one endpoint being replayed
 *    against another. Without them, a signed `GET /v1/device/config` could be replayed as
 *    `POST /v1/device/events` with the same empty body.
 *  - **TIMESTAMP** bounds the replay window to the accepted skew.
 *  - **NONCE** closes the window entirely: a nonce is accepted once, and the server
 *    remembers it for longer than a timestamp stays valid.
 *  - **The body hash** makes the payload tamper-evident. Signing only the headers would
 *    let anyone who captured a request substitute a different body.
 *
 * This module is deliberately pure — no I/O, no database, no clock reads except the one
 * passed in — so it can be tested exhaustively, and so the Go agent's implementation can
 * be checked against the same fixture vectors in test/fixtures/signature-vectors.json.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const HEADER = {
  device: 'x-wl-device',
  timestamp: 'x-wl-timestamp',
  nonce: 'x-wl-nonce',
  signature: 'x-wl-signature',
} as const;

export const NONCE_BYTES = 16;
const NONCE_HEX_LENGTH = NONCE_BYTES * 2;
const SIGNATURE_HEX_LENGTH = 64;

export interface CanonicalRequestParts {
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  body: string;
}

/**
 * Builds the string that gets signed.
 *
 * The method is upper-cased and the path is used exactly as given. Normalising the path
 * here would be a mistake: the agent and the server must agree byte for byte, and any
 * normalisation rule is one more thing that can differ between a Go and a TypeScript
 * implementation. The server signs what the gateway reports as the path, and the agent
 * signs what it puts in the request line.
 */
export function canonicalRequest(parts: CanonicalRequestParts): string {
  const bodyHash = createHash('sha256').update(parts.body, 'utf8').digest('hex');
  return [
    parts.method.toUpperCase(),
    parts.path,
    String(parts.timestamp),
    parts.nonce,
    bodyHash,
  ].join('\n');
}

export function sign(secret: string, parts: CanonicalRequestParts): string {
  return createHmac('sha256', secret).update(canonicalRequest(parts), 'utf8').digest('hex');
}

export function generateNonce(): string {
  return randomBytes(NONCE_BYTES).toString('hex');
}

/**
 * Constant-time comparison of two hex signatures.
 *
 * `timingSafeEqual` throws on length mismatch, and a plain `===` on hex strings leaks the
 * position of the first differing byte through timing. Both are handled: length is
 * checked first against the *expected* length (a constant), so an attacker learns nothing
 * from a short signature beyond the fact that it was short.
 */
export function signaturesMatch(expected: string, provided: string): boolean {
  if (provided.length !== SIGNATURE_HEX_LENGTH || expected.length !== SIGNATURE_HEX_LENGTH) {
    return false;
  }
  // Hex-decode rather than comparing the strings: it halves the compared length and
  // rejects non-hex input via the length check below.
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  if (a.length !== 32 || b.length !== 32) return false;
  return timingSafeEqual(a, b);
}

export type VerificationFailure =
  | { ok: false; reason: 'malformed_nonce' }
  | { ok: false; reason: 'malformed_timestamp' }
  | { ok: false; reason: 'malformed_signature' }
  | { ok: false; reason: 'timestamp_out_of_window'; skewSeconds: number }
  | { ok: false; reason: 'signature_mismatch' };

export type VerificationResult = { ok: true } | VerificationFailure;

export interface VerifyInput extends CanonicalRequestParts {
  secret: string;
  providedSignature: string;
  /** Seconds of tolerated skew in either direction. */
  windowSeconds: number;
  /** Injected rather than read, so tests can pin it and so skew is testable. */
  nowSeconds: number;
}

/**
 * Verifies a signed request. Checks are ordered cheapest-first, and the timestamp is
 * checked *before* the HMAC so that a device with a wrong clock gets a diagnosis
 * ("your clock is off by 4000 seconds") rather than a generic auth failure. That
 * distinction has no security cost — the timestamp is not a secret — and it is the
 * difference between a two-minute fix and an afternoon of confusion.
 */
export function verify(input: VerifyInput): VerificationResult {
  if (!/^[0-9a-f]+$/.test(input.nonce) || input.nonce.length !== NONCE_HEX_LENGTH) {
    return { ok: false, reason: 'malformed_nonce' };
  }

  if (!Number.isInteger(input.timestamp) || input.timestamp <= 0) {
    return { ok: false, reason: 'malformed_timestamp' };
  }

  if (
    !/^[0-9a-f]+$/.test(input.providedSignature) ||
    input.providedSignature.length !== SIGNATURE_HEX_LENGTH
  ) {
    return { ok: false, reason: 'malformed_signature' };
  }

  const skewSeconds = input.nowSeconds - input.timestamp;
  if (Math.abs(skewSeconds) > input.windowSeconds) {
    return { ok: false, reason: 'timestamp_out_of_window', skewSeconds };
  }

  const expected = sign(input.secret, {
    method: input.method,
    path: input.path,
    timestamp: input.timestamp,
    nonce: input.nonce,
    body: input.body,
  });

  if (!signaturesMatch(expected, input.providedSignature)) {
    return { ok: false, reason: 'signature_mismatch' };
  }

  return { ok: true };
}

/**
 * Header extraction. Returns null for anything missing rather than throwing, so the
 * caller decides whether absent credentials are a 401 or an anonymous route.
 *
 * Header names arrive with inconsistent casing depending on the gateway and the client,
 * so lookup is case-insensitive.
 */
export interface SignatureHeaders {
  deviceId: string;
  timestamp: number;
  nonce: string;
  signature: string;
}

export function extractHeaders(
  headers: Record<string, string | undefined>,
): SignatureHeaders | null {
  const lowered = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) lowered.set(key.toLowerCase(), value);
  }

  const deviceId = lowered.get(HEADER.device);
  const timestampRaw = lowered.get(HEADER.timestamp);
  const nonce = lowered.get(HEADER.nonce);
  const signature = lowered.get(HEADER.signature);

  if (
    deviceId === undefined ||
    timestampRaw === undefined ||
    nonce === undefined ||
    signature === undefined
  ) {
    return null;
  }

  // A non-numeric timestamp becomes NaN, which `verify` rejects as malformed. Parsing
  // permissively here and validating there keeps all the rejection logic in one place.
  const timestamp = /^\d{1,15}$/.test(timestampRaw) ? Number(timestampRaw) : Number.NaN;

  return { deviceId, timestamp, nonce, signature };
}
