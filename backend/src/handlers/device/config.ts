/**
 * `GET /v1/device/config` — what the agent is permitted to collect.
 *
 * Polled every 15 minutes. The agent compares `config_version` with the one it holds and
 * reloads only on a change, so this is a cheap call that is nonetheless the single most
 * important one on the device API: it is how an owner turning screenshots off, or adding a
 * banking domain to the exclusion list, actually reaches a laptop.
 *
 * Deliberately *not* wrapped in `withAcknowledgedNotice`. An agent must be able to fetch its
 * configuration before anybody has acknowledged anything — it needs to know the exclusion
 * rules and the work-hours window in order to behave correctly from its first sample, and the
 * notice screen it shows is itself part of that first run.
 */

import { touchConfigFetch } from '../../repositories/devices.js';
import {
  getMonitoringConfig,
  presentMonitoringConfig,
} from '../../repositories/monitoringConfig.js';
import type { DeviceIdentity } from '../../middleware/deviceAuth.js';
import { withDeviceAuth } from '../../middleware/deviceAuth.js';
import { errors } from '../../shared/errors.js';
import type { JsonResponse, RequestContext } from '../../shared/http.js';
import { ok, withHandler } from '../../shared/http.js';

export const handler = withHandler(
  'device-config',
  withDeviceAuth(
    async (_ctx: RequestContext, identity: DeviceIdentity): Promise<JsonResponse> => {
      const row = await getMonitoringConfig(identity.orgId);
      if (row === undefined) {
        // Seeded by wl_seed_org_defaults() when the organisation is created, so its absence is
        // a bootstrap failure rather than a client error. Failing is the right answer: an agent
        // with no configuration must not fall back to defaults of its own choosing.
        throw errors.internal(new Error('organisation has no monitoring_config row'), {
          orgId: identity.orgId,
        });
      }

      // After the read, not before: a poll that fails to return a configuration should not be
      // recorded as a successful fetch. The write is not awaited before the read for
      // performance — it is ordered for honesty.
      const touched = await touchConfigFetch(identity.orgId, identity.deviceId);
      if (touched === undefined) {
        // Revoked between authentication and here. Rare, and the correct answer is the same
        // one the middleware would have given a moment earlier.
        throw errors.deviceRevoked(identity.deviceId);
      }

      return ok({
        config: presentMonitoringConfig(row),
        config_version: row.config_version,
        // Lets the agent notice a clock drift that has not yet grown large enough to fail the
        // signature window, which is what `agentctl doctor` reports on.
        server_time: new Date().toISOString(),
      });
    },
  ),
);
