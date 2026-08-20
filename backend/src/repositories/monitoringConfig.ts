/**
 * The monitoring configuration row — one per organisation, and the agent's only source of
 * truth for what it is permitted to collect.
 *
 * The row is read, never written, from the device API. Changing it is an owner action on the
 * dashboard, audited, and it bumps `config_version`; an agent polls, compares versions, and
 * reloads. That asymmetry is why this file has a reader and no writer.
 */

import type { Tx } from './executor.js';
import { runOne } from './executor.js';

/** Mirrors `monitoring_config` exactly. `time` columns come back as `HH:MM:SS` strings. */
export interface MonitoringConfigRow {
  org_id: string;
  config_version: number;
  sample_interval_seconds: number;
  idle_threshold_seconds: number;
  capture_window_titles: boolean;
  capture_urls: boolean;
  screenshot_enabled: boolean;
  screenshot_interval_seconds: number;
  screenshot_blur: boolean;
  work_hours_only: boolean;
  work_hours_start: string;
  work_hours_end: string;
  work_days: number[];
  excluded_apps: string[];
  excluded_url_patterns: string[];
  retention_days_events: number;
  retention_days_screenshots: number;
}

/**
 * The payload the agent receives.
 *
 * Deliberately a projection rather than the row: `org_id` is already known to the agent,
 * and `config_version` is returned alongside the config rather than inside it so a
 * version comparison does not require the agent to reach into the object it is about to
 * replace.
 */
export interface AgentMonitoringConfig {
  sample_interval_seconds: number;
  idle_threshold_seconds: number;
  capture_window_titles: boolean;
  capture_urls: boolean;
  screenshot_enabled: boolean;
  screenshot_interval_seconds: number;
  screenshot_blur: boolean;
  work_hours_only: boolean;
  work_hours_start: string;
  work_hours_end: string;
  /** ISO-8601 weekdays: 1 = Monday ... 7 = Sunday, matching `extract(isodow from ...)`. */
  work_days: number[];
  excluded_apps: string[];
  excluded_url_patterns: string[];
  retention_days_events: number;
  retention_days_screenshots: number;
}

export async function getMonitoringConfig(
  orgId: string,
  tx?: Tx,
): Promise<MonitoringConfigRow | undefined> {
  return runOne<MonitoringConfigRow>(
    {
      name: 'monitoring-config-get',
      text: `select org_id, config_version, sample_interval_seconds, idle_threshold_seconds,
                    capture_window_titles, capture_urls, screenshot_enabled,
                    screenshot_interval_seconds, screenshot_blur, work_hours_only,
                    work_hours_start, work_hours_end, work_days, excluded_apps,
                    excluded_url_patterns, retention_days_events, retention_days_screenshots
               from monitoring_config
              where org_id = $1`,
      values: [orgId],
    },
    tx,
  );
}

/**
 * Projects the row onto the agent payload.
 *
 * Field-by-field rather than a spread with `org_id` deleted, so adding a column to
 * `monitoring_config` does not silently start shipping it to every device on the fleet. A
 * new setting reaches the agent when someone decides it should.
 */
/**
 * The agent's view of the configuration: the row, plus the employee's timezone.
 *
 * A separate type and function from `presentMonitoringConfig` on purpose. The timezone is not a
 * column on `monitoring_config` — it lives on `employees`, because work hours are local to a person
 * and two employees in one organisation can be in different zones. It belongs in the agent's payload
 * because the agent evaluates the work-hours window locally, before anything is buffered, and it
 * cannot do that without knowing which clock the window is in.
 *
 * It does **not** belong in the dashboard's `GET /config` response, which is why that path keeps the
 * narrower projection. Adding it there would imply the organisation has one timezone, and an admin
 * editing a per-organisation setting should not appear to be editing a per-employee one.
 *
 * The agent requires it: `MonitoringConfig.Validate()` in `internal/config` refuses a configuration
 * with no timezone rather than defaulting to the laptop's, which is user-changeable. Omitting it
 * here means the agent rejects every configuration it fetches — which is precisely what happened
 * until `contracts/device-config-response.json` pinned this shape from both sides.
 */
export interface AgentConfigPayload extends AgentMonitoringConfig {
  /** The employee's IANA zone, from `employees.timezone`. */
  timezone: string;
}

export function presentAgentConfig(
  row: MonitoringConfigRow,
  timezone: string,
): AgentConfigPayload {
  return { ...presentMonitoringConfig(row), timezone };
}

export function presentMonitoringConfig(row: MonitoringConfigRow): AgentMonitoringConfig {
  return {
    sample_interval_seconds: row.sample_interval_seconds,
    idle_threshold_seconds: row.idle_threshold_seconds,
    capture_window_titles: row.capture_window_titles,
    capture_urls: row.capture_urls,
    screenshot_enabled: row.screenshot_enabled,
    screenshot_interval_seconds: row.screenshot_interval_seconds,
    screenshot_blur: row.screenshot_blur,
    work_hours_only: row.work_hours_only,
    work_hours_start: row.work_hours_start,
    work_hours_end: row.work_hours_end,
    work_days: row.work_days,
    excluded_apps: row.excluded_apps,
    excluded_url_patterns: row.excluded_url_patterns,
    retention_days_events: row.retention_days_events,
    retention_days_screenshots: row.retention_days_screenshots,
  };
}
