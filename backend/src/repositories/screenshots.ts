/**
 * Screenshot rows.
 *
 * The image bytes never pass through Lambda: the agent PUTs them straight to S3 through a
 * constrained presigned URL. So the row is written *before* the upload happens, in the
 * `pending` state, and is flipped to `uploaded` afterwards. A row that stays `pending`
 * means the agent asked for a URL and then failed, crashed, or was killed; the retention
 * sweeper expires those.
 *
 * That ordering is what makes the pair of states meaningful. Writing the row after a
 * successful upload would leave orphaned objects in the bucket with nothing in the database
 * pointing at them — screenshots of an employee's screen that no retention policy can find.
 */

import type { Tx } from './executor.js';
import { runOne } from './executor.js';

export interface ScreenshotRow {
  id: string;
  employee_id: string;
  device_id: string;
  captured_at: Date;
  s3_bucket: string;
  s3_key: string;
  content_type: string;
  byte_count: number;
  upload_state: 'pending' | 'uploaded' | 'expired';
  uploaded_at: Date | null;
}

export interface PendingScreenshotInput {
  /** Chosen by the handler, because the S3 key is derived from it. */
  screenshotId: string;
  employeeId: string;
  deviceId: string;
  capturedAt: Date;
  s3Bucket: string;
  s3Key: string;
  contentType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  byteCount: number;
  /** Raw 32 bytes, not hex: the column is `bytea` with an `octet_length = 32` check. */
  sha256: Buffer;
  blurred: boolean;
}

/**
 * Inserts the pending row.
 *
 * `blurred` is recorded rather than inferred so the dashboard can always tell a viewer what
 * they are looking at. A blurred screenshot presented as if it were sharp, or the reverse,
 * misrepresents what was collected.
 */
export async function insertPendingScreenshot(
  orgId: string,
  input: PendingScreenshotInput,
  tx?: Tx,
): Promise<ScreenshotRow> {
  const row = await runOne<ScreenshotRow>(
    {
      name: 'screenshots-insert-pending',
      text: `insert into screenshots (
                   id, org_id, employee_id, device_id, captured_at, s3_bucket, s3_key,
                   content_type, width, height, byte_count, sha256, blurred, upload_state
                 )
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending')
              returning id, employee_id, device_id, captured_at, s3_bucket, s3_key,
                        content_type, byte_count, upload_state, uploaded_at`,
      values: [
        input.screenshotId,
        orgId,
        input.employeeId,
        input.deviceId,
        input.capturedAt.toISOString(),
        input.s3Bucket,
        input.s3Key,
        input.contentType,
        input.width,
        input.height,
        input.byteCount,
        input.sha256,
        input.blurred,
      ],
    },
    tx,
  );

  if (row === undefined) throw new Error('screenshots insert returned no row');
  return row;
}

/**
 * Looks a screenshot up, scoped to both the organisation and the device that created it.
 *
 * Scoping to the device, not just the org, is the point: one laptop must not be able to
 * confirm — or even confirm the existence of — another laptop's upload, even inside the same
 * organisation. The dashboard read path scopes by employee instead, which is a different
 * question asked by a different caller.
 */
export async function findScreenshot(
  orgId: string,
  deviceId: string,
  screenshotId: string,
  tx?: Tx,
): Promise<ScreenshotRow | undefined> {
  return runOne<ScreenshotRow>(
    {
      name: 'screenshots-find',
      text: `select id, employee_id, device_id, captured_at, s3_bucket, s3_key,
                    content_type, byte_count, upload_state, uploaded_at
               from screenshots
              where org_id = $1 and device_id = $2 and id = $3`,
      values: [orgId, deviceId, screenshotId],
    },
    tx,
  );
}

/**
 * Flips a pending row to `uploaded`.
 *
 * Both columns move together because `screenshots_uploaded_chk` ties them: `upload_state =
 * 'uploaded'` if and only if `uploaded_at is not null`. `coalesce` keeps the first
 * completion time, so a retried confirmation is a no-op rather than a rewrite.
 *
 * `upload_state in ('pending', 'uploaded')` excludes `expired`, so a row the retention
 * sweeper has already written off cannot be resurrected by a very late confirmation — the
 * object it pointed at is gone. Returning `undefined` there lets the handler distinguish
 * that from a screenshot that never existed.
 */
export async function markScreenshotUploaded(
  orgId: string,
  deviceId: string,
  screenshotId: string,
  tx?: Tx,
): Promise<ScreenshotRow | undefined> {
  return runOne<ScreenshotRow>(
    {
      name: 'screenshots-mark-uploaded',
      text: `update screenshots
                set upload_state = 'uploaded',
                    uploaded_at  = coalesce(uploaded_at, now())
              where org_id = $1
                and device_id = $2
                and id = $3
                and upload_state in ('pending', 'uploaded')
          returning id, employee_id, device_id, captured_at, s3_bucket, s3_key,
                    content_type, byte_count, upload_state, uploaded_at`,
      values: [orgId, deviceId, screenshotId],
    },
    tx,
  );
}
