/**
 * Tests for device secret derivation.
 *
 * The property being protected: no device credential exists anywhere in the database, and
 * the same (org, device, version) always derives the same secret while any change to any
 * of the three derives a different one.
 */

import { createHmac, randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import {
  currentKeyVersion,
  derivationMessage,
  deriveDeviceSecret,
  deriveDeviceSecretWithKey,
  setRootKeysForTest,
} from '../../src/shared/deviceSecret.js';

const ROOT_V1 = Buffer.alloc(32, 0x11);
const ROOT_V2 = Buffer.alloc(32, 0x22);

const ORG = '3f7a1c0e-2b4d-4f6a-8c1e-9d0b5a7e3c11';
const DEVICE = '9a594a02-afe7-4537-b57a-f771875c3c87';

function withKeys(keys: [number, Buffer][]): void {
  setRootKeysForTest(new Map(keys));
}

afterEach(() => {
  setRootKeysForTest(undefined);
});

describe('derivationMessage', () => {
  it('is version-prefixed and colon-delimited', () => {
    expect(derivationMessage({ orgId: ORG, deviceId: DEVICE, keyVersion: 1 })).toBe(
      `v1:${ORG}:${DEVICE}`,
    );
  });

  it('is unambiguous — no two distinct inputs share a message', () => {
    // Both components are UUIDs and cannot contain a colon, so the delimiter is safe. This
    // test exists so that if either field ever becomes free-form, the ambiguity is caught
    // rather than silently allowing two devices to derive the same secret.
    const messages = new Set([
      derivationMessage({ orgId: ORG, deviceId: DEVICE, keyVersion: 1 }),
      derivationMessage({ orgId: DEVICE, deviceId: ORG, keyVersion: 1 }),
      derivationMessage({ orgId: ORG, deviceId: DEVICE, keyVersion: 2 }),
      derivationMessage({ orgId: ORG, deviceId: DEVICE, keyVersion: 11 }),
    ]);
    expect(messages.size).toBe(4);
  });

  it('does not collide when a version digit could run into the org id', () => {
    // v1 + ":1234..." must not equal v11 + ":234...". The colon after the version is what
    // prevents that, and this pins it.
    expect(derivationMessage({ orgId: '1abc', deviceId: DEVICE, keyVersion: 1 })).not.toBe(
      derivationMessage({ orgId: 'abc', deviceId: DEVICE, keyVersion: 11 }),
    );
  });
});

describe('deriveDeviceSecretWithKey', () => {
  it('matches an independently computed HMAC', () => {
    const expected = createHmac('sha256', ROOT_V1)
      .update(`v1:${ORG}:${DEVICE}`, 'utf8')
      .digest('base64url');

    expect(deriveDeviceSecretWithKey(ROOT_V1, { orgId: ORG, deviceId: DEVICE, keyVersion: 1 })).toBe(
      expected,
    );
  });

  it('is base64url — safe in a header and in a config file without escaping', () => {
    const secret = deriveDeviceSecretWithKey(ROOT_V1, {
      orgId: ORG,
      deviceId: DEVICE,
      keyVersion: 1,
    });
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(secret).not.toContain('+');
    expect(secret).not.toContain('/');
    expect(secret).not.toContain('=');
  });

  it('derives 256 bits of secret', () => {
    const secret = deriveDeviceSecretWithKey(ROOT_V1, {
      orgId: ORG,
      deviceId: DEVICE,
      keyVersion: 1,
    });
    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
  });

  it('is deterministic', () => {
    const input = { orgId: ORG, deviceId: DEVICE, keyVersion: 1 };
    expect(deriveDeviceSecretWithKey(ROOT_V1, input)).toBe(
      deriveDeviceSecretWithKey(ROOT_V1, input),
    );
  });

  it('gives a different secret for every axis that changes', () => {
    const base = deriveDeviceSecretWithKey(ROOT_V1, {
      orgId: ORG,
      deviceId: DEVICE,
      keyVersion: 1,
    });

    const others = [
      // different device in the same org
      deriveDeviceSecretWithKey(ROOT_V1, {
        orgId: ORG,
        deviceId: '00000000-0000-0000-0000-000000000001',
        keyVersion: 1,
      }),
      // same device id, different org — cross-tenant separation
      deriveDeviceSecretWithKey(ROOT_V1, {
        orgId: '00000000-0000-0000-0000-000000000002',
        deviceId: DEVICE,
        keyVersion: 1,
      }),
      // same device, different key version — rotation produces a new secret
      deriveDeviceSecretWithKey(ROOT_V1, { orgId: ORG, deviceId: DEVICE, keyVersion: 2 }),
      // different root key entirely
      deriveDeviceSecretWithKey(ROOT_V2, { orgId: ORG, deviceId: DEVICE, keyVersion: 1 }),
    ];

    for (const other of others) expect(other).not.toBe(base);
    expect(new Set([base, ...others]).size).toBe(5);
  });

  it('binds the version into the message, not just into key selection', () => {
    // If the version were only a selector, the *same* root key under two version numbers
    // would derive the same secret. Because the version is inside the HMAC message, it
    // does not — which keeps each version's output domain distinct.
    expect(deriveDeviceSecretWithKey(ROOT_V1, { orgId: ORG, deviceId: DEVICE, keyVersion: 1 })).not.toBe(
      deriveDeviceSecretWithKey(ROOT_V1, { orgId: ORG, deviceId: DEVICE, keyVersion: 2 }),
    );
  });
});

describe('deriveDeviceSecret', () => {
  it('uses the root key matching the device row version', async () => {
    withKeys([
      [1, ROOT_V1],
      [2, ROOT_V2],
    ]);

    await expect(deriveDeviceSecret({ orgId: ORG, deviceId: DEVICE, keyVersion: 1 })).resolves.toBe(
      deriveDeviceSecretWithKey(ROOT_V1, { orgId: ORG, deviceId: DEVICE, keyVersion: 1 }),
    );
    await expect(deriveDeviceSecret({ orgId: ORG, deviceId: DEVICE, keyVersion: 2 })).resolves.toBe(
      deriveDeviceSecretWithKey(ROOT_V2, { orgId: ORG, deviceId: DEVICE, keyVersion: 2 }),
    );
  });

  it('keeps devices on an older key working through a rotation', async () => {
    // The whole point of the version map: publishing v2 must not strand a device that has
    // not re-enrolled yet.
    withKeys([[1, ROOT_V1]]);
    const before = await deriveDeviceSecret({ orgId: ORG, deviceId: DEVICE, keyVersion: 1 });

    withKeys([
      [1, ROOT_V1],
      [2, ROOT_V2],
    ]);
    const after = await deriveDeviceSecret({ orgId: ORG, deviceId: DEVICE, keyVersion: 1 });

    expect(after).toBe(before);
  });

  it('fails loudly when a device references a retired key version', async () => {
    withKeys([[2, ROOT_V2]]);

    // Silently deriving with a different key would lock the device out with an
    // indistinguishable "signature mismatch". Naming the problem is the difference between
    // a five-minute fix and a long afternoon.
    await expect(
      deriveDeviceSecret({ orgId: ORG, deviceId: DEVICE, keyVersion: 1 }),
    ).rejects.toThrow(/version 1.*not present.*available: 2/s);
  });
});

describe('currentKeyVersion', () => {
  it('is the highest published version, so new enrolments get the newest key', async () => {
    withKeys([
      [1, ROOT_V1],
      [2, ROOT_V2],
    ]);
    await expect(currentKeyVersion()).resolves.toBe(2);
  });

  it('handles a single version', async () => {
    withKeys([[1, ROOT_V1]]);
    await expect(currentKeyVersion()).resolves.toBe(1);
  });

  it('does not assume versions are contiguous', async () => {
    // A rotation that retires v1 and v2 leaves a gap. Max, not count, is what is wanted.
    withKeys([[7, randomBytes(32)]]);
    await expect(currentKeyVersion()).resolves.toBe(7);
  });
});
