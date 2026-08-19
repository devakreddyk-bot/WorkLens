/**
 * Expires replay-protection nonces. Scheduled hourly.
 *
 * Separate from the retention sweeper on purpose, and the reason is worth stating: retention deletes
 * *employee data* on a schedule the organisation configured, while this deletes security bookkeeping
 * on a cadence dictated by the signature window. Conflating them would tie a security control to a
 * dashboard setting — shorten the retention window and you would also shorten the replay-protection
 * window, which is not a trade anybody would choose deliberately.
 */

import { query } from '../../shared/db.js';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';

export interface NonceSweepEvent {
  source?: string;
  /** Override the retention interval, in seconds. Tests and manual runs only. */
  retention_seconds?: number;
}

export interface NonceSweepResponse {
  ok: boolean;
  deleted: number;
  retentionSeconds: number;
  durationMs: number;
}

export async function handler(event: NonceSweepEvent = {}): Promise<NonceSweepResponse> {
  const started = Date.now();
  const log = logger.child({ handler: 'nonce-sweeper', source: event.source ?? 'manual' });

  const retentionSeconds = event.retention_seconds ?? config.NONCE_RETENTION_SECONDS;

  // The floor is the accepted timestamp window. Expiring nonces sooner than a timestamp remains
  // valid reopens exactly the replay hole they exist to close, so this refuses rather than trusting
  // the caller — config.ts enforces the same relationship at load time.
  if (retentionSeconds <= config.HMAC_TIMESTAMP_SKEW_SECONDS) {
    throw new Error(
      `nonce-sweeper: retention of ${retentionSeconds}s is not greater than the ` +
        `${config.HMAC_TIMESTAMP_SKEW_SECONDS}s signature window. Expiring nonces while their ` +
        `timestamps are still accepted would make replays possible.`,
    );
  }

  // wl_sweep_device_nonces is used rather than an inline DELETE so the retention relationship is
  // documented next to the table it protects (migration 0002).
  const result = await query<{ deleted: string }>({
    name: 'nonce-sweep',
    text: `select wl_sweep_device_nonces(make_interval(secs => $1))::text as deleted`,
    values: [retentionSeconds],
  });

  const deleted = Number(result.rows[0]?.deleted ?? '0');

  log.info('swept replay nonces', { deleted, retentionSeconds, durationMs: Date.now() - started });

  return { ok: true, deleted, retentionSeconds, durationMs: Date.now() - started };
}
