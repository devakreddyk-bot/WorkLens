/**
 * Device authentication middleware.
 *
 * **Why this is middleware and not a Lambda authorizer.** The Phase 0 plan assumed a REST
 * API `REQUEST` authorizer would verify agent credentials. It cannot: an API Gateway
 * Lambda authorizer receives headers, path, query string and request context — but *not*
 * the request body. The signature covers a hash of the body (that is the point: it makes
 * the payload tamper-evident), so verification is impossible from inside an authorizer.
 *
 * Verifying in-handler is also better on its own merits. Authorizer results are cached by
 * identity source, and every request here carries a fresh nonce and signature, so every
 * request would be a cache miss — an entire extra Lambda invocation per request, for no
 * caching benefit and additional latency.
 *
 * The order of checks below is deliberate:
 *
 *   1. headers present            — cheapest, no I/O
 *   2. device row lookup          — one indexed read; also yields org_id and key_version
 *   3. revocation                 — before any crypto, so a revoked device costs nothing
 *   4. timestamp window           — before the HMAC, so a wrong clock gets a diagnosis
 *   5. signature                  — constant-time
 *   6. nonce claim                — last, because it *writes*, and a nonce must only be
 *                                   consumed by a request that was otherwise valid
 *
 * Step 6 last matters: claiming the nonce earlier would let anyone who can reach the API
 * burn a device's nonces with unsigned garbage, and — worse — a legitimate agent retrying
 * after a network timeout would find its own nonce already consumed.
 */

import type { PoolClient } from 'pg';

import { config } from '../shared/config.js';
import { isUniqueViolation, query, transaction } from '../shared/db.js';
import { deriveDeviceSecret } from '../shared/deviceSecret.js';
import { AppError, ErrorCode, errors } from '../shared/errors.js';
import type { JsonResponse, RequestContext } from '../shared/http.js';
import { extractHeaders, verify } from '../shared/signature.js';

/** The authenticated caller. Everything downstream takes org and employee from here,
 *  never from the request body — a device cannot claim to belong to another org. */
export interface DeviceIdentity {
  deviceId: string;
  orgId: string;
  employeeId: string;
  keyVersion: number;
  hostname: string;
  agentVersion: string;
  noticeAcknowledgedAt: Date | null;
}

interface DeviceRow {
  id: string;
  org_id: string;
  employee_id: string;
  key_version: number;
  hostname: string;
  agent_version: string;
  revoked_at: Date | null;
  notice_acknowledged_at: Date | null;
}

/** Matches the `uuid` type in the schema. Checked before the query so a malformed id
 *  produces a clean 401 rather than a Postgres cast error. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadDevice(deviceId: string): Promise<DeviceRow | undefined> {
  const result = await query<DeviceRow>({
    name: 'device-auth-load',
    text: `select id, org_id, employee_id, key_version, hostname, agent_version,
                  revoked_at, notice_acknowledged_at
             from devices
            where id = $1`,
    values: [deviceId],
  });
  return result.rows[0];
}

/**
 * Records the nonce, returning false if it was already present.
 *
 * The uniqueness check *is* the insert: a `select` followed by an `insert` has a race
 * window in which two concurrent replays both see nothing and both proceed. Letting the
 * primary key reject the second one is the only version that is actually safe.
 */
async function claimNonce(tx: PoolClient, deviceId: string, nonce: string): Promise<boolean> {
  try {
    await tx.query({
      text: 'insert into device_nonces (device_id, nonce) values ($1, $2)',
      values: [deviceId, nonce],
    });
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

/**
 * Authenticates a signed device request. Throws an AppError on any failure; returns the
 * verified identity on success.
 */
export async function authenticateDevice(ctx: RequestContext): Promise<DeviceIdentity> {
  const headers = extractHeaders(ctx.headers);

  if (headers === null) {
    throw new AppError(
      ErrorCode.MISSING_CREDENTIALS,
      'Request is missing the X-WL-Device, X-WL-Timestamp, X-WL-Nonce or X-WL-Signature header.',
    );
  }

  if (!UUID_RE.test(headers.deviceId)) {
    throw errors.unauthenticated('device_id_malformed');
  }

  const device = await loadDevice(headers.deviceId);

  // An unknown device and a wrong signature return the same code and message on purpose:
  // distinguishing them would let a caller enumerate which device ids exist.
  if (device === undefined) {
    throw errors.unauthenticated('device_unknown', { deviceId: headers.deviceId });
  }

  if (device.revoked_at !== null) {
    throw errors.deviceRevoked(device.id);
  }

  const secret = await deriveDeviceSecret({
    orgId: device.org_id,
    deviceId: device.id,
    keyVersion: device.key_version,
  });

  const result = verify({
    method: ctx.method,
    path: ctx.path,
    timestamp: headers.timestamp,
    nonce: headers.nonce,
    body: ctx.rawBody,
    secret,
    providedSignature: headers.signature,
    windowSeconds: config.HMAC_TIMESTAMP_SKEW_SECONDS,
    nowSeconds: Math.floor(Date.now() / 1000),
  });

  if (!result.ok) {
    if (result.reason === 'timestamp_out_of_window') {
      // Reported specifically: a laptop with a wrong clock is a support call, not an
      // attack, and `agentctl doctor` surfaces it as "your clock is off by N seconds".
      throw errors.timestampOutOfWindow(result.skewSeconds, config.HMAC_TIMESTAMP_SKEW_SECONDS);
    }
    throw errors.unauthenticated(result.reason, { deviceId: device.id });
  }

  const fresh = await transaction((tx) => claimNonce(tx, device.id, headers.nonce));
  if (!fresh) {
    throw errors.replayed(headers.nonce);
  }

  return {
    deviceId: device.id,
    orgId: device.org_id,
    employeeId: device.employee_id,
    keyVersion: device.key_version,
    hostname: device.hostname,
    agentVersion: device.agent_version,
    noticeAcknowledgedAt: device.notice_acknowledged_at,
  };
}

export type DeviceHandler = (
  ctx: RequestContext,
  identity: DeviceIdentity,
) => Promise<JsonResponse>;

/**
 * Wraps a device-route handler so it only ever runs with a verified identity.
 *
 * The logger is rebound with the org and device so every subsequent line in the request is
 * attributable without each call site passing them along.
 */
export function withDeviceAuth(handler: DeviceHandler) {
  return async (ctx: RequestContext): Promise<JsonResponse> => {
    const identity = await authenticateDevice(ctx);

    const authenticatedCtx: RequestContext = {
      ...ctx,
      log: ctx.log.child({
        orgId: identity.orgId,
        deviceId: identity.deviceId,
        employeeId: identity.employeeId,
      }),
    };

    return handler(authenticatedCtx, identity);
  };
}

/**
 * Additionally requires that the employee has acknowledged the first-run notice.
 *
 * Applied to the data-carrying routes — events and screenshots — and deliberately not to
 * config, heartbeat or the acknowledgment route itself, which an agent must be able to
 * call before anyone has acknowledged anything. This is the server-side half of the
 * transparency guarantee: even a tampered agent that skipped its own notice gate cannot
 * get activity data accepted.
 */
export function withAcknowledgedNotice(handler: DeviceHandler): DeviceHandler {
  return async (ctx, identity) => {
    if (identity.noticeAcknowledgedAt === null) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'This device has not recorded the employee acknowledgment of the monitoring notice. ' +
          'Activity data is not accepted until it has.',
        { logContext: { deviceId: identity.deviceId, reason: 'notice_not_acknowledged' } },
      );
    }
    return handler(ctx, identity);
  };
}
