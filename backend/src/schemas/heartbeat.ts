/**
 * `POST /v1/device/heartbeat`.
 *
 * The heartbeat's job is `devices.last_seen_at`. The health counters ride along because the
 * agent is the only thing that can see them — a buffer that is filling up, uploads that keep
 * failing, events dropped because the local queue overflowed — and an operator needs them to
 * tell "quiet employee" apart from "broken agent".
 *
 * **They are not stored.** There is no column on `devices` for any of them, and inventing one
 * is not in scope for this route; the schema is authoritative. They are validated here and
 * emitted as structured log fields, which is where a CloudWatch metric filter and an alarm can
 * reach them. See the note in `src/handlers/device/heartbeat.ts`.
 *
 * Note what the counters are: counts. `last_error_code` is a *code*, capped short, never a
 * message — an error message from a capture failure can contain the window title that caused
 * it, and a field that accepted one would move personal data into CloudWatch under a retention
 * policy the organisation never agreed to.
 */

import { z } from 'zod';

import { bounded } from './common.js';

const counter = (max: number): z.ZodOptional<z.ZodNumber> =>
  z.number().int().min(0).max(max).optional();

export const agentHealthSchema = z
  .object({
    /** Events waiting in the local SQLite buffer. */
    buffered_events: counter(10_000_000),
    /** Screenshots captured but not yet uploaded. */
    queued_screenshots: counter(1_000_000),
    /** Failed upload attempts since the agent started. */
    upload_failures: counter(10_000_000),
    /** Events discarded because the local buffer hit its ceiling — the one that matters most. */
    dropped_events: counter(10_000_000),
    uptime_seconds: counter(3_155_760_000),
    /**
     * A short symbolic code such as `capture_timeout`, chosen from a fixed set on the agent.
     * The character class enforces that it is a symbol rather than prose.
     */
    last_error_code: z
      .string()
      .max(60)
      .regex(/^[a-z0-9_.:-]*$/, 'must be a short symbolic code, not an error message')
      .optional(),
  })
  .strict();

export const heartbeatSchema = z
  .object({
    agent_version: bounded(40, 0).optional(),
    os_version: bounded(100, 0).optional(),
    health: agentHealthSchema.optional(),
  })
  .strict();

export type HeartbeatRequest = z.output<typeof heartbeatSchema>;
export type AgentHealth = z.output<typeof agentHealthSchema>;
