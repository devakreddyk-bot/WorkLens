/**
 * `POST /v1/device/screenshots` — issue a presigned PUT for one screenshot.
 *
 * Image bytes never transit Lambda. The agent uploads straight to S3, which removes the 6 MB
 * payload ceiling and the per-image compute cost — but it also means the only thing standing
 * between a presigned URL and arbitrary use of the bucket is what that URL is signed over. So
 * the signature covers four conditions, and the SDK is configured so that they really are part
 * of the signature rather than merely part of the request:
 *
 *   `content-length`                                  — the exact byte count that was authorised
 *   `content-type`                                    — image/png or image/jpeg, nothing else
 *   `x-amz-server-side-encryption`                    — aws:kms
 *   `x-amz-server-side-encryption-aws-kms-key-id`     — this organisation's CMK
 *
 * Each closes a real hole. Without the length, a URL authorised for a 40 KB screenshot uploads
 * 40 MB of anything. Without the content type, the bucket becomes a file drop. Without the two
 * encryption conditions, the URL can write a *plaintext* object into a bucket whose entire
 * purpose is that screenshots of employees' screens are encrypted at rest.
 *
 * Two SDK details make or break this:
 *
 *  - `content-type` is added to `unsignableHeaders` by the S3 presigner by default, so it has to
 *    be named in `signableHeaders` to be enforced. `content-length` is signable by default but
 *    is listed alongside it so the intent is visible at the call site rather than inferred from
 *    a default. The presigner already forces every `x-amz-server-side-encryption*` header to
 *    stay a signed header rather than being hoisted into the query string.
 *  - `requestChecksumCalculation: 'WHEN_REQUIRED'` is not an optimisation. Left at its default
 *    the SDK computes a CRC32 of the (empty) request body and signs *that* into the URL, so
 *    every upload through it fails with a checksum mismatch on real bytes. This is the kind of
 *    bug that only appears against real S3, so the constraint is pinned by a test on the signed
 *    URL rather than discovered in staging.
 */

import { randomUUID } from 'node:crypto';

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { insertPendingScreenshot } from '../../repositories/screenshots.js';
import { getMonitoringConfig } from '../../repositories/monitoringConfig.js';
import { parseBody } from '../../schemas/parse.js';
import { screenshotPresignSchema } from '../../schemas/screenshots.js';
import type { DeviceIdentity } from '../../middleware/deviceAuth.js';
import { withAcknowledgedNotice, withDeviceAuth } from '../../middleware/deviceAuth.js';
import { config, requireConfig } from '../../shared/config.js';
import { errors } from '../../shared/errors.js';
import type { JsonResponse, RequestContext } from '../../shared/http.js';
import { created, parseJsonBody, withHandler } from '../../shared/http.js';

const SSE_HEADER = 'x-amz-server-side-encryption';
const SSE_KMS_KEY_HEADER = 'x-amz-server-side-encryption-aws-kms-key-id';

/**
 * Module scope, so a warm container reuses the client and its resolved credentials rather than
 * rebuilding both per invocation. The bucket is reached through the VPC's free S3 gateway
 * endpoint, so this needs no route to the internet.
 */
const s3 = new S3Client({
  region: config.AWS_REGION,
  requestChecksumCalculation: 'WHEN_REQUIRED',
});

const EXTENSIONS: Record<'image/png' | 'image/jpeg', string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

/**
 * The object key.
 *
 * Date-partitioned in UTC rather than in the employee's timezone. The timesheet day boundary is
 * per-employee and per-day, but the key is storage layout: it has to be derivable from the row
 * without consulting `employees.timezone`, because the retention sweeper enumerates prefixes and
 * a key that depended on a mutable column would strand objects the moment someone relocated.
 */
function buildKey(
  orgId: string,
  employeeId: string,
  capturedAt: Date,
  screenshotId: string,
  contentType: 'image/png' | 'image/jpeg',
): string {
  const year = capturedAt.getUTCFullYear();
  const month = String(capturedAt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(capturedAt.getUTCDate()).padStart(2, '0');
  return (
    `${config.SCREENSHOT_PREFIX}${orgId}/${employeeId}/${String(year)}/${month}/${day}/` +
    `${screenshotId}.${EXTENSIONS[contentType]}`
  );
}

export const handler = withHandler(
  'screenshot-presign',
  withDeviceAuth(
    withAcknowledgedNotice(
      async (ctx: RequestContext, identity: DeviceIdentity): Promise<JsonResponse> => {
        const monitoringConfig = await getMonitoringConfig(identity.orgId);
        if (monitoringConfig === undefined) {
          throw errors.internal(new Error('organisation has no monitoring_config row'), {
            orgId: identity.orgId,
          });
        }

        // Checked server-side even though the agent also checks it locally. A tampered or
        // out-of-date agent must not be able to upload screenshots into an organisation that
        // has switched the feature off — the local check is a courtesy, this one is the control.
        if (!monitoringConfig.screenshot_enabled) {
          throw errors.featureDisabled('Screenshot capture');
        }

        const body = parseBody(screenshotPresignSchema, parseJsonBody(ctx));

        const bucket = requireConfig('SCREENSHOT_BUCKET');
        const kmsKeyArn = requireConfig('S3_KMS_KEY_ARN');

        const screenshotId = randomUUID();
        const key = buildKey(
          identity.orgId,
          identity.employeeId,
          body.captured_at,
          screenshotId,
          body.content_type,
        );

        // Written before the URL is issued, in `pending`. A presign that is never used therefore
        // leaves a row the retention sweeper can find and expire; the reverse ordering would
        // leave objects in the bucket with nothing in the database pointing at them.
        await insertPendingScreenshot(identity.orgId, {
          screenshotId,
          employeeId: identity.employeeId,
          deviceId: identity.deviceId,
          capturedAt: body.captured_at,
          s3Bucket: bucket,
          s3Key: key,
          contentType: body.content_type,
          width: body.width,
          height: body.height,
          byteCount: body.byte_count,
          sha256: Buffer.from(body.sha256, 'hex'),
          blurred: body.blurred,
        });

        const uploadUrl = await getSignedUrl(
          s3,
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            ContentType: body.content_type,
            ContentLength: body.byte_count,
            ServerSideEncryption: 'aws:kms',
            SSEKMSKeyId: kmsKeyArn,
          }),
          {
            expiresIn: config.PRESIGN_EXPIRY_SECONDS,
            signableHeaders: new Set(['content-length', 'content-type']),
          },
        );

        ctx.log.info('screenshot presigned', {
          screenshotId,
          bytes: body.byte_count,
          blurred: body.blurred,
          expiresIn: config.PRESIGN_EXPIRY_SECONDS,
        });

        return created({
          screenshot_id: screenshotId,
          upload_url: uploadUrl,
          s3_bucket: bucket,
          s3_key: key,
          expires_in_seconds: config.PRESIGN_EXPIRY_SECONDS,
          /**
           * Spelled out because the URL is signed over these exact values: an upload that omits
           * one, or sends a different one, is rejected by S3 with a signature mismatch that
           * looks nothing like its cause. Telling the agent what to send turns a confusing
           * failure into a contract.
           */
          required_headers: {
            'content-length': String(body.byte_count),
            'content-type': body.content_type,
            [SSE_HEADER]: 'aws:kms',
            [SSE_KMS_KEY_HEADER]: kmsKeyArn,
          },
        });
      },
    ),
  ),
);
