/**
 * `POST /v1/device/enroll` — the one device route with no HMAC.
 *
 * There cannot be one: the device secret is what this call produces, so the enrolment token is
 * the entire credential. That makes the token's single-use property the whole of the
 * protection, and it is enforced by the database rather than by this code (see
 * `src/repositories/enrollment.ts`). WAF rate limiting and the token's expiry bound the rest.
 *
 * Everything that touches the database happens in one transaction, in this order:
 *
 *   1. look the token up          — establishes which org and employee this is
 *   2. insert the device          — needed before step 3, because `used_by_device_id` is a FK
 *   3. mark the token used        — `where used_at is null`; losing this aborts the whole thing
 *   4. read the monitoring config — so the agent starts with the right settings immediately
 *   5. write the audit row        — a credential was issued; that is an auditable event
 *
 * Step 3 is what makes a concurrent double-enrolment safe. The loser's `UPDATE` matches no row,
 * this function throws, the transaction rolls back, and the device row it inserted at step 2
 * goes with it. One token, one device, always.
 *
 * The root-key lookup and the secret derivation sit *outside* the transaction on purpose. On a
 * cold start the key lookup is a Secrets Manager call, and with `DB_POOL_MAX = 1` holding the
 * container's only database connection open across a network round trip is exactly the kind of
 * thing that turns a slow dependency into a stalled function. By the time derivation runs the
 * keys are cached, so it is pure computation.
 *
 * The secret is returned once and never stored — not hashed, not encrypted, not written
 * anywhere. It is recomputed on every request from the root key and the device's `key_version`
 * (docs/PLAN.md deviation D4), so a database dump yields no working device credential.
 */

import { createHash, randomUUID } from 'node:crypto';

import { insertAuditLog, deviceActorEmail } from '../../repositories/audit.js';
import { insertDevice } from '../../repositories/devices.js';
import {
  lookupEnrollmentToken,
  markEnrollmentTokenUsed,
} from '../../repositories/enrollment.js';
import {
  getMonitoringConfig,
  presentMonitoringConfig,
} from '../../repositories/monitoringConfig.js';
import { enrollRequestSchema } from '../../schemas/enroll.js';
import { parseBody } from '../../schemas/parse.js';
import { transaction } from '../../shared/db.js';
import { currentKeyVersion, deriveDeviceSecret } from '../../shared/deviceSecret.js';
import { AppError, ErrorCode, errors } from '../../shared/errors.js';
import type { JsonResponse, RequestContext } from '../../shared/http.js';
import { created, parseJsonBody, withHandler } from '../../shared/http.js';

interface EnrolledDeviceContext {
  deviceId: string;
  orgId: string;
  employeeId: string;
  keyVersion: number;
  config: ReturnType<typeof presentMonitoringConfig>;
  configVersion: number;
}

/**
 * Maps the three token failures onto the codes in `src/shared/errors.ts`.
 *
 * They are deliberately distinguished, which is a departure from the "never tell a caller
 * which half of the credential was wrong" rule that governs the signed routes. The reasoning
 * differs: an enrolment token is held by an operator standing at a laptop, not by an
 * attacker probing an endpoint, and "this token has already been used" versus "this token
 * expired" is the difference between "the device is already enrolled" and "ask for a new
 * token". The token is 256 bits of CSPRNG output, so the distinction leaks nothing that helps
 * anyone guess one.
 */
function tokenFailure(status: 'not_found' | 'expired' | 'used'): AppError {
  switch (status) {
    case 'not_found':
      return new AppError(
        ErrorCode.INVALID_TOKEN,
        'This enrollment token is not recognised. Check it was copied in full, or ask an ' +
          'administrator to issue a new one.',
        { logContext: { reason: 'enrollment_token_unknown' } },
      );
    case 'expired':
      return new AppError(
        ErrorCode.ENROLLMENT_TOKEN_EXPIRED,
        'This enrollment token has expired. Ask an administrator to issue a new one.',
        { logContext: { reason: 'enrollment_token_expired' } },
      );
    case 'used':
      return new AppError(
        ErrorCode.ENROLLMENT_TOKEN_USED,
        'This enrollment token has already been used. Each token enrolls exactly one device.',
        { logContext: { reason: 'enrollment_token_used' } },
      );
  }
}

export const handler = withHandler('enroll', async (ctx: RequestContext): Promise<JsonResponse> => {
  const body = parseBody(enrollRequestSchema, parseJsonBody(ctx));

  // Only the digest ever leaves this line. The token is not logged, not stored, and not
  // included in any error.
  const tokenHash = createHash('sha256').update(body.token, 'utf8').digest();

  // Resolved before the transaction opens: see the note at the top of the file.
  const keyVersion = await currentKeyVersion();

  // Chosen here rather than defaulted by the database because the device secret is derived
  // from it, and because the enrolment token has to be stamped with it in the same transaction.
  const deviceId = randomUUID();

  const enrolled = await transaction<EnrolledDeviceContext>(async (tx) => {
    const lookup = await lookupEnrollmentToken(tokenHash, tx);
    if (lookup.status !== 'usable') throw tokenFailure(lookup.status);

    const { org_id: orgId, employee_id: employeeId, id: tokenId } = lookup.token;

    const device = await insertDevice(
      orgId,
      deviceId,
      {
        employeeId,
        hostname: body.hostname,
        os: body.os,
        osVersion: body.os_version,
        agentVersion: body.agent_version,
        machineFingerprint: body.machine_fingerprint,
        keyVersion,
      },
      tx,
    );

    const won = await markEnrollmentTokenUsed(orgId, tokenId, device.id, tx);
    if (!won) {
      // A concurrent enrolment committed between the lookup and here. Throwing rolls this
      // transaction back, so the device row above never existed.
      throw tokenFailure('used');
    }

    const monitoringConfig = await getMonitoringConfig(orgId, tx);
    if (monitoringConfig === undefined) {
      // Every organisation gets its monitoring_config row from wl_seed_org_defaults() at
      // creation. Its absence is a bootstrap failure, not a client error: the agent would
      // otherwise have to invent its own collection settings, which is the one thing it must
      // never do.
      throw errors.internal(new Error('organisation has no monitoring_config row'), { orgId });
    }

    await insertAuditLog(
      orgId,
      {
        actorEmail: deviceActorEmail(device.id),
        actorRole: 'device',
        action: 'device.enrolled',
        subjectType: 'device',
        subjectId: device.id,
        subjectEmployeeId: employeeId,
        ip: ctx.sourceIp,
        userAgent: ctx.userAgent,
        metadata: {
          os: body.os,
          hostname: body.hostname,
          agent_version: body.agent_version,
          key_version: keyVersion,
        },
      },
      tx,
    );

    return {
      deviceId: device.id,
      orgId,
      employeeId,
      keyVersion: device.key_version,
      config: presentMonitoringConfig(monitoringConfig),
      configVersion: monitoringConfig.config_version,
    };
  });

  const deviceSecret = await deriveDeviceSecret({
    orgId: enrolled.orgId,
    deviceId: enrolled.deviceId,
    keyVersion: enrolled.keyVersion,
  });

  ctx.log.info('device enrolled', {
    orgId: enrolled.orgId,
    deviceId: enrolled.deviceId,
    employeeId: enrolled.employeeId,
    keyVersion: enrolled.keyVersion,
  });

  return created({
    device_id: enrolled.deviceId,
    // Returned exactly once. The agent writes it to a user-and-Administrators-only ACL and
    // never logs it; the field name is one the logger redacts, so an accidental log of this
    // whole object still would not print it.
    device_secret: deviceSecret,
    key_version: enrolled.keyVersion,
    org_id: enrolled.orgId,
    employee_id: enrolled.employeeId,
    config: enrolled.config,
    config_version: enrolled.configVersion,
  });
});
