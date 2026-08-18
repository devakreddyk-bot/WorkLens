/**
 * Asserts the TypeScript signing implementation matches the cross-language contract.
 *
 * `contracts/signature-vectors.json` is the pinned agreement between the Go agent that signs
 * requests and this backend that verifies them. The two share no code, so nothing else forces
 * them to agree — and a divergence presents as "signature mismatch" on every request from
 * every device, with no clue as to which side is wrong.
 *
 * This test and `agent/internal/signing/signing_test.go` read the same file. If either
 * implementation drifts, its own suite fails, in its own language, before anything ships.
 *
 * A vector changing is a **protocol change**: every deployed agent stops authenticating.
 * Regenerate with `npm run gen:vectors` only when that is what you intend.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { deriveDeviceSecretWithKey } from '../../src/shared/deviceSecretDerivation.js';
import { canonicalRequest, sign, verify } from '../../src/shared/signature.js';

interface SigningCase {
  name: string;
  why: string;
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  body: string;
  expectedCanonicalRequest: string;
  expectedSignature: string;
}

interface Contract {
  algorithm: {
    timestampWindowSeconds: number;
    canonicalRequest: string;
  };
  deviceSecretDerivation: {
    rootKeyBase64: string;
    orgId: string;
    deviceId: string;
    keyVersion: number;
    expectedSecret: string;
  };
  signing: {
    deviceSecret: string;
    cases: SigningCase[];
  };
}

const CONTRACT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'contracts',
  'signature-vectors.json',
);

const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as Contract;

describe('signing contract', () => {
  it('is present and describes at least the cases that matter', () => {
    // A contract file that silently went missing or empty would make every assertion below
    // vacuously pass, so its shape is checked first.
    expect(contract.signing.cases.length).toBeGreaterThanOrEqual(8);

    const names = contract.signing.cases.map((c) => c.name);
    for (const required of [
      'empty-body-get',
      'utf8-window-title',
      'body-with-newlines',
      'path-with-percent-encoding',
      'lowercase-method',
    ]) {
      expect(names).toContain(required);
    }
  });

  it('states the timestamp window the agent must honour', () => {
    expect(contract.algorithm.timestampWindowSeconds).toBe(300);
  });
});

describe('device secret derivation matches the contract', () => {
  it('derives the pinned secret from the pinned root key', () => {
    const { rootKeyBase64, orgId, deviceId, keyVersion, expectedSecret } =
      contract.deviceSecretDerivation;

    expect(
      deriveDeviceSecretWithKey(Buffer.from(rootKeyBase64, 'base64'), {
        orgId,
        deviceId,
        keyVersion,
      }),
    ).toBe(expectedSecret);
  });
});

describe.each(contract.signing.cases)('vector: $name', (testCase) => {
  const { deviceSecret } = contract.signing;

  it(`builds the pinned canonical request — ${testCase.why}`, () => {
    expect(canonicalRequest(testCase)).toBe(testCase.expectedCanonicalRequest);
  });

  it('produces the pinned signature', () => {
    expect(sign(deviceSecret, testCase)).toBe(testCase.expectedSignature);
  });

  it('verifies its own pinned signature', () => {
    // The agent will send exactly this. If verification of a pinned signature ever fails,
    // the fleet is locked out.
    expect(
      verify({
        ...testCase,
        secret: deviceSecret,
        providedSignature: testCase.expectedSignature,
        windowSeconds: contract.algorithm.timestampWindowSeconds,
        nowSeconds: testCase.timestamp,
      }),
    ).toEqual({ ok: true });
  });
});

describe('properties the vectors are chosen to pin', () => {
  function caseNamed(name: string): SigningCase {
    const found = contract.signing.cases.find((c) => c.name === name);
    if (found === undefined) throw new Error(`vector "${name}" is missing from the contract`);
    return found;
  }

  it('upper-cases the method: the lowercase vector signs identically to the uppercase one', () => {
    expect(caseNamed('lowercase-method').expectedSignature).toBe(
      caseNamed('simple-json-post').expectedSignature,
    );
  });

  it('keeps the body out of the canonical request, appearing only as a hash', () => {
    const utf8 = caseNamed('utf8-window-title');
    expect(utf8.expectedCanonicalRequest).not.toContain('Übersicht');
    expect(utf8.expectedCanonicalRequest.split('\n')).toHaveLength(5);
  });

  it('hashes UTF-8 bytes, not UTF-16 code units', () => {
    // The concrete failure this prevents: an implementation that hashed UTF-16 would produce
    // a different digest for exactly the users whose window titles are non-ASCII, and work
    // fine for everyone else.
    const utf8 = caseNamed('utf8-window-title');
    expect(sign(contract.signing.deviceSecret, utf8)).toBe(utf8.expectedSignature);
    expect(Buffer.byteLength(utf8.body, 'utf8')).toBeGreaterThan(utf8.body.length);
  });

  it('is not confused by newlines in the body', () => {
    // The canonical form is newline-delimited; a body containing newlines must not be able
    // to shift the field boundaries, because the body only ever appears as a fixed-length
    // hex digest.
    const withNewlines = caseNamed('body-with-newlines');
    expect(withNewlines.body).toContain('\n');
    expect(withNewlines.expectedCanonicalRequest.split('\n')).toHaveLength(5);
  });

  it('uses the path verbatim, without decoding percent-encoding', () => {
    const encoded = caseNamed('path-with-percent-encoding');
    expect(encoded.expectedCanonicalRequest.split('\n')[1]).toBe('/v1/device/config%20');
  });

  it('uses a 32-character lower-case hex nonce throughout', () => {
    for (const c of contract.signing.cases) {
      expect(c.nonce).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('produces a 64-character lower-case hex signature throughout', () => {
    for (const c of contract.signing.cases) {
      expect(c.expectedSignature).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
