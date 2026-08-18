/**
 * Building genuinely signed device requests for the handler tests.
 *
 * The alternative — stubbing `withDeviceAuth` — was rejected. The middleware is where the notice
 * gate lives, and one of the required assertions is that a data-carrying route refuses a device
 * whose employee has not acknowledged the monitoring notice. A test that replaced the middleware
 * would be asserting against its own stub. Signing for real costs about fifteen lines and means
 * every handler test exercises the header extraction, the timestamp window, the constant-time
 * signature comparison and the nonce claim on the way in.
 *
 * Root key material is injected with `setRootKeysForTest`, so nothing here reaches Secrets
 * Manager.
 */

import { randomBytes } from 'node:crypto';

import { setRootKeysForTest, deriveDeviceSecretWithKey } from '../../src/shared/deviceSecret.js';
import type { ApiEvent } from '../../src/shared/http.js';
import { HEADER, generateNonce, sign } from '../../src/shared/signature.js';

import { whenQuery } from './dbMock.js';

export const KEY_VERSION = 1;
export const ROOT_KEY = Buffer.alloc(32, 0x5a);

export const ORG_ID = '2f1a6e40-8c3b-4a1d-9f77-0b6e5c4a1d33';
export const EMPLOYEE_ID = '7c9e2b18-4d5a-4c6b-8e21-3f0a9d7b6c55';
export const DEVICE_ID = 'a41b7d62-95c8-4e3f-b0a7-6d2c5e918f44';
export const HOSTNAME = 'WL-LAPTOP-014';
export const SOURCE_IP = '203.0.113.10';

export function installRootKeys(): void {
  setRootKeysForTest(new Map([[KEY_VERSION, ROOT_KEY]]));
}

export function clearRootKeys(): void {
  setRootKeysForTest(undefined);
}

export function deviceSecret(deviceId = DEVICE_ID, orgId = ORG_ID): string {
  return deriveDeviceSecretWithKey(ROOT_KEY, { orgId, deviceId, keyVersion: KEY_VERSION });
}

/** A `wlen_` token in the exact shape the enrolment schema accepts. */
export function enrollmentToken(): string {
  return `wlen_${randomBytes(32).toString('base64url')}`;
}

export interface DeviceRowOverrides {
  noticeAcknowledgedAt?: Date | null;
  revokedAt?: Date | null;
  agentVersion?: string;
}

/**
 * Registers the row `src/middleware/deviceAuth.ts` looks up, so a signed request authenticates.
 *
 * The default acknowledges the notice, because most routes are uninteresting without it; the
 * test that cares passes `noticeAcknowledgedAt: null` explicitly.
 */
export function mockDeviceRow(overrides: DeviceRowOverrides = {}): void {
  whenQuery(/^select id, org_id, employee_id, key_version, hostname, agent_version/, [
    {
      id: DEVICE_ID,
      org_id: ORG_ID,
      employee_id: EMPLOYEE_ID,
      key_version: KEY_VERSION,
      hostname: HOSTNAME,
      agent_version: overrides.agentVersion ?? '0.1.0',
      revoked_at: overrides.revokedAt ?? null,
      notice_acknowledged_at:
        overrides.noticeAcknowledgedAt === undefined
          ? new Date('2026-05-01T08:00:00.000Z')
          : overrides.noticeAcknowledgedAt,
    },
  ]);
}

export interface EventInit {
  method: string;
  path: string;
  /** Serialised as JSON; the signature covers exactly these bytes. */
  body?: unknown;
  headers?: Record<string, string>;
  pathParameters?: Record<string, string>;
}

function baseEvent(init: EventInit, headers: Record<string, string>): ApiEvent {
  const rawBody = init.body === undefined ? '' : JSON.stringify(init.body);

  // A full APIGatewayProxyEvent has some forty fields, almost all of which `src/shared/http.ts`
  // never reads. Constructing only what it reads keeps the fixture legible; the cast is the price.
  return {
    httpMethod: init.method,
    path: init.path,
    headers,
    body: rawBody === '' ? null : rawBody,
    isBase64Encoded: false,
    pathParameters: init.pathParameters ?? null,
    queryStringParameters: null,
    requestContext: {
      requestId: 'test-request-id',
      identity: { sourceIp: SOURCE_IP },
    },
  } as unknown as ApiEvent;
}

/** An unauthenticated event, for the enrolment route. */
export function plainEvent(init: EventInit): ApiEvent {
  return baseEvent(init, {
    'content-type': 'application/json',
    'user-agent': 'worklens-agent/0.1.0',
    ...init.headers,
  });
}

export interface SignedEventInit extends EventInit {
  deviceId?: string;
  secret?: string;
  timestamp?: number;
  nonce?: string;
}

export function signedEvent(init: SignedEventInit): ApiEvent {
  const deviceId = init.deviceId ?? DEVICE_ID;
  const secret = init.secret ?? deviceSecret(deviceId);
  const timestamp = init.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = init.nonce ?? generateNonce();
  const rawBody = init.body === undefined ? '' : JSON.stringify(init.body);

  const signature = sign(secret, {
    method: init.method,
    path: init.path,
    timestamp,
    nonce,
    body: rawBody,
  });

  return baseEvent(init, {
    'content-type': 'application/json',
    'user-agent': 'worklens-agent/0.1.0',
    [HEADER.device]: deviceId,
    [HEADER.timestamp]: String(timestamp),
    [HEADER.nonce]: nonce,
    [HEADER.signature]: signature,
    ...init.headers,
  });
}

export interface HandlerResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Invokes a wrapped handler and decodes the proxy result. */
export async function invoke(
  handler: (event: ApiEvent) => Promise<{
    statusCode: number;
    headers?: Record<string, unknown> | undefined;
    body: string;
  }>,
  event: ApiEvent,
): Promise<HandlerResponse> {
  const result = await handler(event);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(result.headers ?? {})) {
    headers[key.toLowerCase()] = String(value);
  }
  return {
    statusCode: result.statusCode,
    headers,
    body: result.body === '' ? {} : (JSON.parse(result.body) as Record<string, unknown>),
  };
}

/** The `error` object from a failed response, narrowed for assertions. */
export interface ErrorEnvelope {
  code: string;
  message: string;
  details?: { field?: string; message: string }[];
  requestId: string;
}

export function errorOf(response: HandlerResponse): ErrorEnvelope {
  return response.body.error as ErrorEnvelope;
}
