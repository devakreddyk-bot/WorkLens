/**
 * `POST /v1/device/screenshots/{id}/complete` — confirm the direct-to-S3 upload landed.
 *
 * Small, but it is what separates "a screenshot exists" from "the agent asked for a URL and then
 * something went wrong". Rows left `pending` past 24 hours are swept, so this call is the only
 * thing that keeps an image in the system.
 *
 * Scoped to the calling device, not just the organisation. One laptop confirming another's
 * upload would be a way to keep an image alive that its own device never managed to send — and,
 * more simply, one device has no business learning that another device's screenshot exists.
 */

import { findScreenshot, markScreenshotUploaded } from '../../repositories/screenshots.js';
import { emptyBody, UUID_PATTERN } from '../../schemas/common.js';
import { parseBody } from '../../schemas/parse.js';
import type { DeviceIdentity } from '../../middleware/deviceAuth.js';
import { withAcknowledgedNotice, withDeviceAuth } from '../../middleware/deviceAuth.js';
import { AppError, ErrorCode, errors } from '../../shared/errors.js';
import type { JsonResponse, RequestContext } from '../../shared/http.js';
import { ok, parseJsonBody, withHandler } from '../../shared/http.js';

export const handler = withHandler(
  'screenshot-complete',
  withDeviceAuth(
    withAcknowledgedNotice(
      async (ctx: RequestContext, identity: DeviceIdentity): Promise<JsonResponse> => {
        const screenshotId = ctx.pathParameters.id;

        // Checked before the query so a malformed path segment produces a 404 rather than a
        // Postgres cast error surfacing as a 500.
        if (screenshotId === undefined || !UUID_PATTERN.test(screenshotId)) {
          throw errors.notFound('Screenshot');
        }

        // The route takes no body. Validating that rather than ignoring it means an agent that
        // starts sending a field finds out immediately instead of assuming it is being read.
        parseBody(emptyBody, parseJsonBody(ctx));

        const updated = await markScreenshotUploaded(
          identity.orgId,
          identity.deviceId,
          screenshotId,
        );

        if (updated === undefined) {
          // Two different situations, and the agent should act differently on each: an unknown
          // id is a bug or a stale queue entry, while an expired row means the retention sweeper
          // already wrote the upload off and the local file should be discarded rather than
          // retried. Only reached on the unhappy path, so the extra read costs nothing normally.
          const existing = await findScreenshot(
            identity.orgId,
            identity.deviceId,
            screenshotId,
          );
          if (existing === undefined) throw errors.notFound('Screenshot');

          throw new AppError(
            ErrorCode.CONFLICT,
            'This screenshot upload has expired and can no longer be completed. Discard the ' +
              'local copy.',
            { logContext: { screenshotId, uploadState: existing.upload_state } },
          );
        }

        ctx.log.info('screenshot upload completed', { screenshotId });

        return ok({
          screenshot_id: updated.id,
          upload_state: updated.upload_state,
          uploaded_at: updated.uploaded_at?.toISOString() ?? null,
        });
      },
    ),
  ),
);
