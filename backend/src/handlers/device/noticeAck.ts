/**
 * `POST /v1/device/notice-ack` — the employee acknowledged the first-run monitoring notice.
 *
 * This is the server-side half of the transparency guarantee. The agent shows the notice and will
 * not capture until it is acknowledged locally; this records the acknowledgment centrally, and
 * `withAcknowledgedNotice` then refuses activity data from any device that has not sent one. So
 * even an agent built from patched source, with its own notice gate removed, cannot get an
 * employee's activity accepted.
 *
 * Necessarily *not* wrapped in `withAcknowledgedNotice` — it is the route that satisfies it.
 *
 * The stored moment is the server's, and the request carries no timestamp to override it. A
 * client-supplied acknowledgment time on a column that exists to evidence that a monitored person
 * was informed would be evidence of nothing; and accepting the field only to ignore it would be
 * worse, because it would look like it worked.
 */

import { insertAuditLog, deviceActorEmail } from '../../repositories/audit.js';
import { acknowledgeNotice } from '../../repositories/devices.js';
import { emptyBody } from '../../schemas/common.js';
import { parseBody } from '../../schemas/parse.js';
import type { DeviceIdentity } from '../../middleware/deviceAuth.js';
import { withDeviceAuth } from '../../middleware/deviceAuth.js';
import { errors } from '../../shared/errors.js';
import type { JsonResponse, RequestContext } from '../../shared/http.js';
import { ok, parseJsonBody, withHandler } from '../../shared/http.js';

export const handler = withHandler(
  'notice-ack',
  withDeviceAuth(
    async (ctx: RequestContext, identity: DeviceIdentity): Promise<JsonResponse> => {
      parseBody(emptyBody, parseJsonBody(ctx));

      const ack = await acknowledgeNotice(identity.orgId, identity.deviceId);
      if (ack === undefined) {
        throw errors.deviceRevoked(identity.deviceId);
      }

      const alreadyAcknowledged = ack.previous_acknowledged_at !== null;

      // Written once, on the call that actually recorded the acknowledgment. A retry — which an
      // offline-tolerant agent will produce — must not append a second row claiming the employee
      // acknowledged the notice twice.
      if (!alreadyAcknowledged) {
        await insertAuditLog(identity.orgId, {
          actorEmail: deviceActorEmail(identity.deviceId),
          actorRole: 'device',
          action: 'device.notice_acknowledged',
          subjectType: 'device',
          subjectId: identity.deviceId,
          subjectEmployeeId: identity.employeeId,
          ip: ctx.sourceIp,
          userAgent: ctx.userAgent,
          metadata: { hostname: identity.hostname },
        });

        ctx.log.info('monitoring notice acknowledged', {
          acknowledgedAt: ack.notice_acknowledged_at.toISOString(),
        });
      }

      return ok({
        device_id: ack.device_id,
        // Unchanged across repeated calls: `coalesce` in the UPDATE keeps the first value, so the
        // recorded moment stays the moment the employee actually acknowledged.
        notice_acknowledged_at: ack.notice_acknowledged_at.toISOString(),
        already_acknowledged: alreadyAcknowledged,
      });
    },
  ),
);
