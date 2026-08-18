/**
 * Generates the cross-language signing contract at `contracts/signature-vectors.json`.
 *
 * The agent (Go) signs requests; the backend (TypeScript) verifies them. Nothing in either
 * codebase forces the two implementations to agree — they share no code, and a difference in
 * how either one builds the canonical string produces a fleet that authenticates against
 * nothing, with "signature mismatch" as the only symptom. That is the most likely integration
 * failure in this project, and it is invisible until a real agent talks to a real backend.
 *
 * So the contract is pinned as data. This script derives the vectors from
 * `src/shared/signature.ts` — the verifier is the authority, since it decides what is
 * acceptable — and both languages have a test that reads the same file:
 *
 *   backend/test/shared/signatureVectors.test.ts   asserts the TS implementation matches
 *   agent/internal/signing/signing_test.go         asserts the Go implementation matches
 *
 * Either one drifting fails its own test suite, in its own language, before anything is
 * deployed.
 *
 * The cases are chosen for where the two languages are most likely to differ: multi-byte
 * UTF-8 (window titles are routinely non-ASCII), an empty body, a body containing newlines
 * (the canonical form is newline-delimited, so a naive implementation could be confused by
 * one), and a path with a percent-encoded segment.
 *
 * Regenerate with:  npm run gen:vectors
 * Then run both test suites. If a vector changes, that is a protocol change and every
 * deployed agent stops authenticating — treat it as a breaking change, not a fix.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalRequest, sign } from '../src/shared/signature.js';
import { deriveDeviceSecretWithKey } from '../src/shared/deviceSecretDerivation.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(HERE, '..', '..', 'contracts');
const OUTPUT_FILE = join(OUTPUT_DIR, 'signature-vectors.json');

/** Fixed, obviously-fake key material. These vectors are public test data, not secrets. */
const ROOT_KEY_BASE64 = Buffer.alloc(32, 0x2b).toString('base64');
const SECRET = 'dGVzdC1zZWNyZXQtbm90LWEtcmVhbC1kZXZpY2Utc2VjcmV0';
const ORG_ID = '3f7a1c0e-2b4d-4f6a-8c1e-9d0b5a7e3c11';
const DEVICE_ID = '9a594a02-afe7-4537-b57a-f771875c3c87';

interface Case {
  name: string;
  why: string;
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  body: string;
}

const CASES: Case[] = [
  {
    name: 'empty-body-get',
    why: 'The config poll. An empty body still contributes a sha256 of the empty string, not an omitted line.',
    method: 'GET',
    path: '/v1/device/config',
    timestamp: 1_760_000_000,
    nonce: '0123456789abcdef0123456789abcdef',
    body: '',
  },
  {
    name: 'simple-json-post',
    why: 'The ordinary ingest case.',
    method: 'POST',
    path: '/v1/device/events',
    timestamp: 1_760_000_000,
    nonce: 'ffffffffffffffff0000000000000000',
    body: '{"events":[]}',
  },
  {
    name: 'lowercase-method',
    why: 'The method is upper-cased before signing, so a client sending a lower-case verb still verifies.',
    method: 'post',
    path: '/v1/device/events',
    timestamp: 1_760_000_000,
    nonce: 'ffffffffffffffff0000000000000000',
    body: '{"events":[]}',
  },
  {
    name: 'utf8-window-title',
    why: 'Window titles are routinely non-ASCII. Both sides must hash the same UTF-8 bytes; a UTF-16 or latin-1 assumption fails only for these users.',
    method: 'POST',
    path: '/v1/device/events',
    timestamp: 1_760_000_123,
    nonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    body: '{"window_title":"Rapport trimestriel — Übersicht — 日本語 — 🙂"}',
  },
  {
    name: 'body-with-newlines',
    why: 'The canonical form is newline-delimited. A body containing newlines must not be able to shift the field boundaries.',
    method: 'POST',
    path: '/v1/device/events',
    timestamp: 1_760_000_456,
    nonce: '00112233445566778899aabbccddeeff',
    body: '{\n  "events": [\n    {"app_name": "code.exe"}\n  ]\n}',
  },
  {
    name: 'path-with-uuid-segment',
    why: 'A path parameter is signed as it appears on the wire, not as the route template.',
    method: 'POST',
    path: '/v1/device/screenshots/7d8e9f10-1112-4314-8516-171819202122/complete',
    timestamp: 1_760_000_789,
    nonce: 'deadbeefdeadbeefdeadbeefdeadbeef',
    body: '{}',
  },
  {
    name: 'path-with-percent-encoding',
    why: 'The path is used verbatim. Neither side may decode or re-encode it, or the two disagree on the bytes.',
    method: 'GET',
    path: '/v1/device/config%20',
    timestamp: 1_760_000_999,
    nonce: '13579bdf02468ace13579bdf02468ace',
    body: '',
  },
  {
    name: 'large-batch-body',
    why: 'A realistic full batch, so a length- or chunking-related difference shows up.',
    method: 'POST',
    path: '/v1/device/events',
    timestamp: 1_760_001_234,
    nonce: '99887766554433221100aabbccddeeff',
    body: JSON.stringify({
      events: Array.from({ length: 50 }, (_, i) => ({
        client_event_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        event_type: 'window_sample',
        captured_at: '2026-08-19T02:30:00.000Z',
        duration_seconds: 60,
        app_name: 'code.exe',
        is_idle: false,
      })),
    }),
  },
];

async function main(): Promise<void> {
  const rootKey = Buffer.from(ROOT_KEY_BASE64, 'base64');

  const document = {
    $comment: [
      'Cross-language signing contract for the WorkLens device API. GENERATED FILE — edit',
      'backend/scripts/genSignatureVectors.ts and run `npm run gen:vectors` instead.',
      '',
      'The Go agent signs and the TypeScript backend verifies. They share no code, so these',
      'vectors are what keeps them agreeing. Both languages have a test that reads this file:',
      '  backend/test/shared/signatureVectors.test.ts',
      '  agent/internal/signing/signing_test.go',
      '',
      'A changed vector is a PROTOCOL change: every deployed agent stops authenticating.',
      'Treat it as breaking, not as a fix.',
      '',
      'The key material here is fixed, obviously fake, public test data.',
    ],
    algorithm: {
      canonicalRequest: 'METHOD \\n PATH \\n TIMESTAMP \\n NONCE \\n hex(sha256(BODY))',
      signature: 'hex(hmac-sha256(deviceSecret, canonicalRequest))',
      deviceSecret: 'base64url(hmac-sha256(rootKey, "v<keyVersion>:<orgId>:<deviceId>"))',
      methodCasing: 'upper-cased before signing',
      pathHandling: 'used verbatim; never normalised, decoded or re-encoded',
      bodyEncoding: 'UTF-8 bytes',
      nonce: '16 random bytes, lower-case hex (32 characters)',
      timestampWindowSeconds: 300,
    },
    deviceSecretDerivation: {
      rootKeyBase64: ROOT_KEY_BASE64,
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      keyVersion: 1,
      expectedSecret: deriveDeviceSecretWithKey(rootKey, {
        orgId: ORG_ID,
        deviceId: DEVICE_ID,
        keyVersion: 1,
      }),
    },
    signing: {
      deviceSecret: SECRET,
      cases: CASES.map((testCase) => ({
        ...testCase,
        expectedCanonicalRequest: canonicalRequest(testCase),
        expectedSignature: sign(SECRET, testCase),
      })),
    },
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(OUTPUT_FILE, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  console.log(`wrote ${document.signing.cases.length} signing vectors to contracts/signature-vectors.json`);
  for (const testCase of document.signing.cases) {
    console.log(`  ${testCase.name.padEnd(28)} ${testCase.expectedSignature.slice(0, 16)}…`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
