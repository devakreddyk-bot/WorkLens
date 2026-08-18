/**
 * `POST /v1/device/screenshots` and `POST /v1/device/screenshots/{id}/complete`.
 *
 * The presign request describes an image the server never sees. Everything it claims —
 * dimensions, byte count, digest — is recorded and then *enforced by the presigned URL*
 * rather than trusted: `byte_count` becomes a signed `Content-Length` condition, so a device
 * that asks to upload 40 KB and then attempts 40 MB is refused by S3, not by us.
 *
 * `MAX_SCREENSHOT_BYTES` is applied here rather than in the handler so that an oversized
 * request comes back as a field-level 400 naming `byte_count`, which is actionable, instead of
 * a bare "too large".
 */

import { z } from 'zod';

import { config } from '../shared/config.js';

import { contentTypeSchema, isoInstant, sha256Hex } from './common.js';

/** `screenshots.byte_count` is `between 0 and 20971520`; the configured cap may be lower. */
const SCHEMA_MAX_SCREENSHOT_BYTES = 20_971_520;

/** `screenshots.width` / `.height` are both `between 1 and 20000`. */
const MAX_PIXELS = 20_000;

const effectiveMaxBytes = Math.min(config.MAX_SCREENSHOT_BYTES, SCHEMA_MAX_SCREENSHOT_BYTES);

export const screenshotPresignSchema = z
  .object({
    captured_at: isoInstant(),

    width: z.number().int().min(1).max(MAX_PIXELS),
    height: z.number().int().min(1).max(MAX_PIXELS),

    /**
     * A zero-byte screenshot is not a screenshot, so the floor is 1 even though the column
     * permits 0 — a presigned PUT of nothing would produce an empty object that the dashboard
     * would render as a broken image.
     */
    byte_count: z
      .number()
      .int()
      .min(1)
      .max(
        effectiveMaxBytes,
        `must not exceed ${effectiveMaxBytes} bytes (MAX_SCREENSHOT_BYTES)`,
      ),

    /** Recorded so a later integrity check can prove the stored object is the one uploaded. */
    sha256: sha256Hex(),

    /**
     * Whether the blur privacy control was applied on the device before upload. Recorded, and
     * surfaced in the dashboard, so a viewer always knows what they are looking at.
     */
    blurred: z.boolean(),

    content_type: contentTypeSchema.default('image/png'),
  })
  .strict();

export type ScreenshotPresignRequest = z.output<typeof screenshotPresignSchema>;
