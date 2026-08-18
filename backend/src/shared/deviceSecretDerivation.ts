/**
 * Device secret derivation — the arithmetic, with no I/O.
 *
 * Split from `deviceSecret.ts` deliberately. That module fetches root keys from Secrets
 * Manager and therefore depends on the environment; this one depends on nothing but
 * `node:crypto`, which means:
 *
 *  - the derivation can be tested without mocking AWS or setting a single variable;
 *  - `scripts/genSignatureVectors.ts` can produce the cross-language contract without
 *    standing up a configuration;
 *  - the security-relevant part of the scheme is readable in one short file.
 *
 * The scheme itself (docs/PLAN.md deviation D4):
 *
 *     device_secret = base64url( HMAC-SHA256( root_key[v], "v<v>:<org_id>:<device_id>" ) )
 *
 * The version is inside the HMAC message, not merely used to select the key. If it were only
 * a selector, the same root key published under two version numbers would derive the same
 * secret; binding it into the message keeps each version's output domain distinct.
 */

import { createHmac } from 'node:crypto';

/** Root keys shorter than this would silently weaken every secret derived from them. */
export const MIN_ROOT_KEY_BYTES = 32;

export interface DeriveInput {
  orgId: string;
  deviceId: string;
  keyVersion: number;
}

/**
 * The message that gets signed.
 *
 * Colon-delimited over values that cannot themselves contain a colon — both are UUIDs — so
 * the encoding is unambiguous and no two distinct inputs can produce the same message.
 */
export function derivationMessage(input: DeriveInput): string {
  return `v${input.keyVersion}:${input.orgId}:${input.deviceId}`;
}

export function deriveDeviceSecretWithKey(rootKey: Buffer, input: DeriveInput): string {
  return createHmac('sha256', rootKey).update(derivationMessage(input), 'utf8').digest('base64url');
}
