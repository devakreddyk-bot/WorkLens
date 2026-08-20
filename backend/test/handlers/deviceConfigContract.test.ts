/**
 * The backend half of the device-config contract.
 *
 * `contracts/device-config-response.json` is the agreement between the server that produces this
 * payload and the Go agent that consumes it; `agent/internal/config/contract_test.go` is the other
 * half. Neither side imports the other — the agent is a separate module that cross-compiles for
 * Windows — so this file is what keeps them agreeing.
 *
 * It exists because they did not agree, and nothing detected it. The agent's daemon passed the whole
 * response body to a parser whose fields sit at the top level, so only `config_version` matched;
 * every setting decoded to its zero value and validation rejected the result on every poll. The
 * `timezone` field was also absent from the response entirely, which would have failed the same
 * validation for a second, independent reason.
 *
 * The failure was silent and safe, which is the worst pair: the agent kept its cached configuration
 * and never collected more than it was permitted to, so nothing looked broken — while an owner could
 * turn screenshots off, watch the change save, and have it reach no device at all. That is the one
 * call `handlers/device/config.ts` describes as "the single most important one on the device API".
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  presentAgentConfig,
  presentMonitoringConfig,
  type MonitoringConfigRow,
} from '../../src/repositories/monitoringConfig.js';

interface Contract {
  response: {
    config: Record<string, unknown>;
    config_version: number;
    server_time: string;
  };
  expected: {
    configVersionAfterParse: number;
    envelopeKeys: string[];
    requiredConfigKeys: string[];
  };
}

const CONTRACT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'contracts',
  'device-config-response.json',
);

const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as Contract;

/** The row the contract's `config` object is the projection of. */
const ROW: MonitoringConfigRow = {
  org_id: '00000000-0000-4000-8000-000000000001',
  config_version: 7,
  sample_interval_seconds: 60,
  idle_threshold_seconds: 300,
  capture_window_titles: true,
  capture_urls: false,
  screenshot_enabled: false,
  screenshot_interval_seconds: 900,
  screenshot_blur: true,
  work_hours_only: true,
  work_hours_start: '09:00',
  work_hours_end: '17:30',
  work_days: [1, 2, 3, 4, 5],
  excluded_apps: ['KeePassXC', '1Password'],
  excluded_url_patterns: ['*.bank.example', '*/health-records/*'],
  retention_days_events: 90,
  retention_days_screenshots: 30,
};

const TIMEZONE = 'Asia/Kolkata';

describe('device-config contract', () => {
  it('is present and non-vacuous', () => {
    // A contract file that went missing or empty would make every assertion below pass for the
    // wrong reason.
    expect(contract.expected.requiredConfigKeys.length).toBeGreaterThanOrEqual(16);
    expect(contract.expected.envelopeKeys).toEqual(['config', 'config_version', 'server_time']);
  });

  it('produces exactly the config object the contract pins', () => {
    // The assertion that matters: what the code actually emits, against what the agent is tested to
    // parse. Not a subset match — an extra field here reaches every device on the fleet.
    expect(presentAgentConfig(ROW, TIMEZONE)).toEqual(contract.response.config);
  });

  it('carries the timezone, which is not a monitoring_config column', () => {
    const payload = presentAgentConfig(ROW, TIMEZONE);
    expect(payload.timezone).toBe(TIMEZONE);

    // It comes from `employees.timezone`, so it cannot be derived from the row. If this ever starts
    // reading the row, the row has grown a column and that is a schema decision, not a projection.
    expect(Object.keys(ROW)).not.toContain('timezone');
  });

  it('keeps the timezone out of the dashboard projection', () => {
    // The dashboard's `GET /config` edits a per-organisation setting. Putting a per-employee value
    // in that response would imply an organisation has one timezone, and would offer an admin a
    // field that does not mean what it appears to.
    expect(presentMonitoringConfig(ROW)).not.toHaveProperty('timezone');
    expect(Object.keys(presentAgentConfig(ROW, TIMEZONE))).toHaveLength(
      Object.keys(presentMonitoringConfig(ROW)).length + 1,
    );
  });

  it('does not put config_version inside the config object', () => {
    // It belongs in the envelope, so a version comparison does not require the agent to reach into
    // the object it is about to replace. The Go side merges it back in on parse.
    expect(presentAgentConfig(ROW, TIMEZONE)).not.toHaveProperty('config_version');
    expect(contract.response.config).not.toHaveProperty('config_version');
    expect(contract.response.config_version).toBe(contract.expected.configVersionAfterParse);
  });

  it('does not ship a monitoring_config column the agent was never given', () => {
    // `presentMonitoringConfig` is field-by-field rather than a spread precisely so a new column
    // does not silently reach the fleet. This asserts that property rather than trusting the style:
    // every key in the agent payload is either a row column or the timezone.
    const allowed = new Set([...Object.keys(ROW), 'timezone']);
    for (const key of Object.keys(presentAgentConfig(ROW, TIMEZONE))) {
      expect(allowed, `unexpected key ${key} in the agent payload`).toContain(key);
    }
    // And org_id is withheld: the agent already knows it, and it has no business in a config object.
    expect(presentAgentConfig(ROW, TIMEZONE)).not.toHaveProperty('org_id');
  });

  it('pins every field the agent validates', () => {
    // The agent's Validate() refuses a configuration missing any of these, so a rename on this side
    // is a protocol break. Adding a field is compatible — Go ignores unknown keys.
    const emitted = new Set(Object.keys(presentAgentConfig(ROW, TIMEZONE)));
    for (const key of contract.expected.requiredConfigKeys) {
      expect(emitted, `the contract requires ${key}`).toContain(key);
    }
  });
});
