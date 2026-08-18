/**
 * Device rows: enrolment, liveness, revocation, the transparency-notice acknowledgment,
 * and the per-device ingest quota.
 *
 * Every function takes `org_id` first and filters on it, even though a device id is a
 * primary key and could be looked up without one. The org filter is not for performance;
 * it is the isolation guarantee. A handler that has been handed the wrong device id cannot
 * reach across an organisation boundary, because the statement will simply match no rows.
 *
 * Looking a device up *by id alone* — the one place where the org is not yet known, because
 * it is what authentication is trying to establish — lives in `src/middleware/deviceAuth.ts`
 * and deliberately does not have a twin here.
 */

import type { QuerySpec } from '../shared/db.js';

import type { Tx } from './executor.js';
import { runOne } from './executor.js';

/** The columns handlers actually read back. Not the whole row: nothing needs it. */
export interface DeviceStateRow {
  id: string;
  employee_id: string;
  key_version: number;
  last_seen_at: Date | null;
  last_config_fetch_at: Date | null;
  notice_acknowledged_at: Date | null;
  revoked_at: Date | null;
}

export interface EnrolDeviceInput {
  employeeId: string;
  hostname: string;
  os: 'windows' | 'darwin' | 'linux';
  osVersion: string;
  agentVersion: string;
  machineFingerprint: string;
  keyVersion: number;
}

export interface EnrolledDevice {
  id: string;
  employee_id: string;
  key_version: number;
  enrolled_at: Date;
}

/**
 * Inserts the device row for a successful enrolment.
 *
 * `id` is supplied by the caller rather than defaulted by the database because the
 * enrolment transaction has to stamp the new device id onto the enrollment token in the
 * same statement sequence, and the derived secret is a function of the id — so the id has
 * to exist before either can happen.
 *
 * Note what is absent: no secret, no hash of a secret, nothing derived from one. The
 * `key_version` is the entire credential record (docs/PLAN.md deviation D4).
 */
export async function insertDevice(
  orgId: string,
  deviceId: string,
  input: EnrolDeviceInput,
  tx?: Tx,
): Promise<EnrolledDevice> {
  const spec: QuerySpec = {
    name: 'devices-insert',
    text: `insert into devices (
                 id, org_id, employee_id, hostname, os, os_version,
                 agent_version, machine_fingerprint, key_version
               )
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            returning id, employee_id, key_version, enrolled_at`,
    values: [
      deviceId,
      orgId,
      input.employeeId,
      input.hostname,
      input.os,
      input.osVersion,
      input.agentVersion,
      input.machineFingerprint,
      input.keyVersion,
    ],
  };

  const row = await runOne<EnrolledDevice>(spec, tx);
  if (row === undefined) {
    // An INSERT ... RETURNING that returns nothing cannot happen: a conflict throws, and a
    // successful insert returns its row. If this ever fires the assumption above is wrong,
    // and silently returning a half-built device would be far worse than failing.
    throw new Error('devices insert returned no row');
  }
  return row;
}

/**
 * Heartbeat: records liveness and, when the agent reports one, its version.
 *
 * `coalesce($3, agent_version)` rather than a plain assignment, so a heartbeat that omits
 * the version does not blank out a version an earlier request established.
 */
export async function touchLastSeen(
  orgId: string,
  deviceId: string,
  agentVersion?: string,
  osVersion?: string,
): Promise<DeviceStateRow | undefined> {
  return runOne<DeviceStateRow>({
    name: 'devices-touch-last-seen',
    text: `update devices
              set last_seen_at  = now(),
                  agent_version = coalesce($3, agent_version),
                  os_version    = coalesce($4, os_version)
            where org_id = $1
              and id = $2
              and revoked_at is null
        returning id, employee_id, key_version, last_seen_at, last_config_fetch_at,
                  notice_acknowledged_at, revoked_at`,
    values: [orgId, deviceId, agentVersion ?? null, osVersion ?? null],
  });
}

/**
 * Config poll: records the fetch, and counts as liveness too.
 *
 * An agent that is polling config is demonstrably alive, and treating that as a heartbeat
 * means a device does not look stale in the dashboard merely because its heartbeat and its
 * config poll landed on different sides of a threshold.
 */
export async function touchConfigFetch(
  orgId: string,
  deviceId: string,
  agentVersion?: string,
): Promise<DeviceStateRow | undefined> {
  return runOne<DeviceStateRow>({
    name: 'devices-touch-config-fetch',
    text: `update devices
              set last_config_fetch_at = now(),
                  last_seen_at         = now(),
                  agent_version        = coalesce($3, agent_version)
            where org_id = $1
              and id = $2
              and revoked_at is null
        returning id, employee_id, key_version, last_seen_at, last_config_fetch_at,
                  notice_acknowledged_at, revoked_at`,
    values: [orgId, deviceId, agentVersion ?? null],
  });
}

export interface NoticeAcknowledgment {
  device_id: string;
  notice_acknowledged_at: Date;
  /** Null when this call is what recorded the acknowledgment. */
  previous_acknowledged_at: Date | null;
}

/**
 * Records the employee's acknowledgment of the first-run monitoring notice.
 *
 * Idempotent in the strong sense: `coalesce` means a second call does not move the
 * timestamp, so the recorded moment stays the moment the employee actually acknowledged.
 * That matters because this column is the deployer's evidence that a monitored person was
 * informed — a value that drifts forward on every retry is not evidence of anything.
 *
 * The CTE reads the pre-update value. A CTE and the UPDATE it feeds both see the snapshot
 * taken at the start of the statement, so `previous_acknowledged_at` is the old value even
 * though `notice_acknowledged_at` is the new one. That is what lets the handler write
 * exactly one audit row for the first acknowledgment rather than one per retry.
 */
export async function acknowledgeNotice(
  orgId: string,
  deviceId: string,
): Promise<NoticeAcknowledgment | undefined> {
  return runOne<NoticeAcknowledgment>({
    name: 'devices-acknowledge-notice',
    text: `with previous as (
                 select id, notice_acknowledged_at
                   from devices
                  where org_id = $1 and id = $2 and revoked_at is null
               )
               update devices d
                  set notice_acknowledged_at = coalesce(d.notice_acknowledged_at, now()),
                      last_seen_at           = now()
                 from previous p
                where d.id = p.id
            returning d.id as device_id,
                      d.notice_acknowledged_at,
                      p.notice_acknowledged_at as previous_acknowledged_at`,
    values: [orgId, deviceId],
  });
}

export interface RevokedDevice {
  id: string;
  employee_id: string;
  revoked_at: Date;
}

/**
 * Revokes a device. Also idempotent via `coalesce`: re-revoking keeps the original moment,
 * which is the one that matters if anyone ever has to reconstruct when a laptop stopped
 * being trusted.
 *
 * Revocation is checked on every authenticated request, so it takes effect on the device's
 * next call rather than after a credential expires (docs/PLAN.md deviation D3).
 */
export async function revokeDevice(
  orgId: string,
  deviceId: string,
  tx?: Tx,
): Promise<RevokedDevice | undefined> {
  return runOne<RevokedDevice>(
    {
      name: 'devices-revoke',
      text: `update devices
                set revoked_at = coalesce(revoked_at, now())
              where org_id = $1
                and id = $2
          returning id, employee_id, revoked_at`,
      values: [orgId, deviceId],
    },
    tx,
  );
}

export interface QuotaWindow {
  /** Events a device may submit per window. */
  limit: number;
  windowSeconds: number;
}

export interface QuotaDecision {
  allowed: boolean;
  /** Events counted against the current window, including this batch. */
  eventCount: number;
  limit: number;
  /** Seconds until the current window rolls over. Becomes `Retry-After` on a 429. */
  retryAfterSeconds: number;
}

interface QuotaRow {
  quota_event_count: number;
  retry_after_seconds: number;
}

/**
 * Claims quota for `eventCount` events, atomically.
 *
 * This is one statement on purpose. The obvious implementation — read the window, decide,
 * write the new count — has a race that an agent hits routinely rather than rarely: two
 * batches from the same device in flight together both read the same count, both decide
 * they fit, and both write, so the second silently erases the first. A device could then
 * exceed its quota indefinitely by simply uploading in parallel, which is exactly the
 * behaviour of the malfunctioning agent this quota exists to contain.
 *
 * So the reset and the increment are a single `UPDATE ... RETURNING`. Inside `SET`, every
 * reference to `quota_window_started_at` is the *old* value, so both `CASE` arms test the
 * same thing and cannot disagree; `RETURNING` then reports the new values. Row-level
 * locking serialises concurrent batches from the same device, and batches from different
 * devices touch different rows and do not contend at all.
 *
 * A rejected batch still consumes quota. That is deliberate: if being over the limit made
 * a request free, a hostile agent could hammer the endpoint at no cost, and the counter
 * would stop being a bound on the work it can cause.
 *
 * Returns `undefined` when the device row is gone or revoked — a device revoked between
 * authentication and this statement, which the caller must treat as a refusal, not as
 * unlimited quota.
 */
export async function consumeIngestQuota(
  orgId: string,
  deviceId: string,
  eventCount: number,
  window: QuotaWindow,
): Promise<QuotaDecision | undefined> {
  const row = await runOne<QuotaRow>({
    name: 'devices-consume-quota',
    text: `update devices
              set quota_window_started_at = case
                      when quota_window_started_at
                           <= now() - make_interval(secs => $3::double precision)
                      then now()
                      else quota_window_started_at
                  end,
                  quota_event_count = case
                      when quota_window_started_at
                           <= now() - make_interval(secs => $3::double precision)
                      then $4::integer
                      else quota_event_count + $4::integer
                  end
            where org_id = $1
              and id = $2
              and revoked_at is null
        returning quota_event_count,
                  ceil(extract(epoch from (
                      quota_window_started_at
                      + make_interval(secs => $3::double precision) - now()
                  )))::integer as retry_after_seconds`,
    values: [orgId, deviceId, window.windowSeconds, eventCount],
  });

  if (row === undefined) return undefined;

  return {
    allowed: row.quota_event_count <= window.limit,
    eventCount: row.quota_event_count,
    limit: window.limit,
    // Clamped to at least one second: a `Retry-After: 0` invites an immediate retry, which
    // is the one thing a rate-limited client must not do.
    retryAfterSeconds: Math.max(1, Math.min(row.retry_after_seconds, window.windowSeconds)),
  };
}
