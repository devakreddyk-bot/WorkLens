/**
 * Device secret derivation (docs/PLAN.md deviation D4).
 *
 * HMAC verification needs the device's secret in plaintext at verify time, so hashing it
 * in the database — the right answer for a password — is not available here. The usual
 * fallback is to store the secret encrypted and decrypt per request, which means either a
 * KMS call in the hot path or a decryption key sitting next to the ciphertext.
 *
 * This does neither. The secret is *derived* on demand:
 *
 *     device_secret = base64url( HMAC-SHA256( root_key[v], "v<v>:<org_id>:<device_id>" ) )
 *
 * Consequences:
 *
 *  - **No secret material is stored in the database at all.** A dump of the `devices`
 *    table yields no working credential. The table records only `key_version`.
 *  - **Revocation is a database write**, not a credential expiry — `devices.revoked_at` is
 *    checked on every request, so revocation takes effect on the next call.
 *  - **Rotation is additive.** Publish `root_key` v2, and devices move to it as they
 *    re-enrol; v1 keeps working for devices still on it because the version is part of
 *    both the stored row and the derivation input.
 *
 * The version is inside the HMAC message, not just used to select the key. If it were
 * only a selector, two root keys could in principle derive the same secret for the same
 * device; binding it into the message makes each version's output domain distinct.
 */

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import { config, requireConfig } from './config.js';
import { deriveDeviceSecretWithKey, MIN_ROOT_KEY_BYTES } from './deviceSecretDerivation.js';
import type { DeriveInput } from './deviceSecretDerivation.js';
import { logger } from './logger.js';

// Re-exported so callers have one import site for the whole scheme; the pure arithmetic
// lives in deviceSecretDerivation.ts so it can be used without any configuration.
export { derivationMessage, deriveDeviceSecretWithKey, MIN_ROOT_KEY_BYTES } from './deviceSecretDerivation.js';
export type { DeriveInput } from './deviceSecretDerivation.js';

export const CURRENT_KEY_VERSION = 1;

/**
 * Shape of the Secrets Manager payload. A JSON map of version to key, rather than a bare
 * string, so a rotation can publish v2 alongside v1 in one secret and no device is
 * stranded mid-rotation.
 *
 *     { "1": "<base64 32 bytes>", "2": "<base64 32 bytes>" }
 */
type RootKeyMap = Record<string, string>;

let client: SecretsManagerClient | undefined;

/**
 * Cached for the life of the container. This is the reason the Secrets Manager interface
 * endpoint is affordable: one call per cold start, not one per request.
 *
 * No TTL. A rotation that adds a version does not invalidate the versions already
 * cached, and a rotation that *removes* one requires the functions to cycle anyway —
 * which they do, since Lambda recycles containers within minutes to hours. A TTL here
 * would buy nothing and add a per-request clock check.
 */
let cachedKeys: Promise<Map<number, Buffer>> | undefined;

function parseRootKeys(raw: string): Map<number, Buffer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'The device root key secret is not valid JSON. Expected a map of key version to ' +
        'base64-encoded key material, e.g. {"1":"<base64>"}. Terraform creates it in this ' +
        'shape; a hand-edited secret is the usual cause.',
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('The device root key secret must be a JSON object of version to key.');
  }

  const keys = new Map<number, Buffer>();
  for (const [version, value] of Object.entries(parsed as RootKeyMap)) {
    if (!/^\d+$/.test(version)) {
      throw new Error(`Device root key has a non-numeric version "${version}".`);
    }
    if (typeof value !== 'string' || value === '') {
      throw new Error(`Device root key version ${version} has no key material.`);
    }

    const material = Buffer.from(value, 'base64');
    if (material.length < MIN_ROOT_KEY_BYTES) {
      // A short root key would silently weaken every device secret derived from it, and
      // nothing downstream would look wrong. Fail loudly instead.
      throw new Error(
        `Device root key version ${version} is ${material.length} bytes; at least ` +
          `${MIN_ROOT_KEY_BYTES} are required.`,
      );
    }
    keys.set(Number(version), material);
  }

  if (keys.size === 0) {
    throw new Error('The device root key secret contains no key versions.');
  }

  return keys;
}

/** Exported so tests can inject key material without touching AWS. */
export function setRootKeysForTest(keys: Map<number, Buffer> | undefined): void {
  cachedKeys = keys === undefined ? undefined : Promise.resolve(keys);
}

async function fetchRootKeys(): Promise<Map<number, Buffer>> {
  const secretArn = requireConfig('DEVICE_ROOT_KEY_SECRET_ARN');

  client ??= new SecretsManagerClient({
    region: config.AWS_REGION,
    // Three attempts, then fail. A device whose enrolment or ingest fails is not a
    // catastrophe — the agent buffers and retries — so it is better to fail fast than to
    // hold a Lambda invocation open retrying a secret fetch.
    maxAttempts: 3,
  });

  const started = Date.now();
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));

  if (response.SecretString === undefined) {
    throw new Error(
      'The device root key secret has no string value. A binary secret is not supported.',
    );
  }

  const keys = parseRootKeys(response.SecretString);
  logger.info('device root keys loaded', {
    // The versions are not sensitive; the material is, and never leaves this module.
    versions: [...keys.keys()],
    durationMs: Date.now() - started,
  });
  return keys;
}

/**
 * The in-flight promise is what gets memoised, not the resolved map. Caching the resolved
 * value leaves a window between "started fetching" and "stored the result" in which a
 * second caller starts its own fetch, so a cold start that handles two concurrent requests
 * makes two Secrets Manager calls. Memoising the promise collapses them into one.
 *
 * A rejected promise is cleared, so a transient failure does not poison the container for
 * the rest of its life.
 */
function loadRootKeys(): Promise<Map<number, Buffer>> {
  cachedKeys ??= fetchRootKeys().catch((err: unknown) => {
    cachedKeys = undefined;
    throw err;
  });
  return cachedKeys;
}

export async function deriveDeviceSecret(input: DeriveInput): Promise<string> {
  const keys = await loadRootKeys();
  const rootKey = keys.get(input.keyVersion);

  if (rootKey === undefined) {
    throw new Error(
      `Device references root key version ${input.keyVersion}, which is not present in ` +
        `the secret (available: ${[...keys.keys()].join(', ')}). A version was retired ` +
        `while devices were still using it; re-publish it, or re-enrol those devices.`,
    );
  }

  return deriveDeviceSecretWithKey(rootKey, input);
}

/** The version new enrolments are issued against: the highest version present. */
export async function currentKeyVersion(): Promise<number> {
  const keys = await loadRootKeys();
  return Math.max(...keys.keys());
}
