/**
 * `POST /v1/device/heartbeat` — liveness, version, and health counters.
 *
 * Not wrapped in `withAcknowledgedNotice`. A device that has not yet had its notice acknowledged
 * is still a device an operator needs to see in the dashboard — a laptop stuck on the first-run
 * screen is precisely the situation someone has to notice and go fix, and gating the heartbeat
 * would make it invisible instead.
 *
 * **The health counters are not persisted.** `devices` has no column for a buffer depth or an
 * upload-failure count, and the schema is authoritative: inventing one is not something this
 * handler gets to do. They are validated and written to the log as structured fields, which is
 * where a CloudWatch metric filter can turn `dropped_events` into an alarm — arguably a better
 * home for a monotonically increasing counter than a row that would be overwritten every minute.
 */

import { touchLastSeen } from '../../repositories/devices.js';
import { heartbeatSchema } from '../../schemas/heartbeat.js';
import { parseBody } from '../../schemas/parse.js';
import type { DeviceIdentity } from '../../middleware/deviceAuth.js';
import { withDeviceAuth } from '../../middleware/deviceAuth.js';
import { errors } from '../../shared/errors.js';
import type { JsonResponse, RequestContext } from '../../shared/http.js';
import { ok, parseJsonBody, withHandler } from '../../shared/http.js';

export const handler = withHandler(
  'heartbeat',
  withDeviceAuth(
    async (ctx: RequestContext, identity: DeviceIdentity): Promise<JsonResponse> => {
      const body = parseBody(heartbeatSchema, parseJsonBody(ctx));

      const device = await touchLastSeen(
        identity.orgId,
        identity.deviceId,
        body.agent_version,
        body.os_version,
      );

      if (device === undefined) {
        throw errors.deviceRevoked(identity.deviceId);
      }

      if (body.health !== undefined) {
        // Counters only — no error messages, no titles. `last_error_code` is constrained by the
        // schema to a symbolic code for exactly this reason: a capture failure's message can
        // contain the window title that caused it.
        ctx.log.info('agent health reported', {
          agentVersion: body.agent_version,
          ...body.health,
        });
      }

      return ok({
        device_id: device.id,
        last_seen_at: device.last_seen_at?.toISOString() ?? null,
        notice_acknowledged: device.notice_acknowledged_at !== null,
        // Lets the agent detect clock drift before it grows past the ±300 s signature window and
        // starts producing authentication failures it cannot diagnose on its own.
        server_time: new Date().toISOString(),
      });
    },
  ),
);
