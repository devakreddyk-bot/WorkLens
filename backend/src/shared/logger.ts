/**
 * Structured JSON logging with mandatory redaction.
 *
 * Two things make this more than a console.log wrapper:
 *
 *  1. **Redaction is not optional.** Every value that goes through this logger is walked
 *     and anything whose key looks like a credential is replaced. A handler cannot log a
 *     device secret by accident, because there is no path to the log that skips this. The
 *     redaction is tested against a known secret in test/shared/logger.test.ts.
 *
 *  2. **Window titles are treated as personal data.** They are the single most sensitive
 *     field WorkLens handles — a title can name a document, a patient, a client, a
 *     medical condition. They are redacted from logs unless LOG_REQUEST_BODIES is
 *     explicitly on, which config.ts refuses to allow in production.
 *
 * Output is one JSON object per line, which is what CloudWatch Logs Insights queries.
 */

import { config } from './config.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Keys whose values never appear in a log, at any nesting depth. Matched
 * case-insensitively as a substring, so `deviceSecret`, `device_secret` and
 * `DEVICE_SECRET_B64` are all caught by `secret`.
 */
const REDACTED_KEY_PATTERNS = [
  'secret',
  'password',
  'token',
  'credential',
  'authorization',
  'signature',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'rootkey',
  'root_key',
  'cookie',
  'sessionid',
  'session_id',
] as const;

/**
 * Keys holding personal data. Redacted unless request-body logging is explicitly
 * enabled, which is a non-production-only setting.
 */
const PERSONAL_DATA_KEY_PATTERNS = [
  'window_title',
  'windowtitle',
  'url_title',
  'urltitle',
  'page_title',
  'pagetitle',
] as const;

const REDACTED = '[redacted]';
const REDACTED_PII = '[redacted:personal-data]';

/** Depth cap: a cyclic or pathologically nested object must not be able to hang a log call. */
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 2000;

function keyMatches(key: string, patterns: readonly string[]): boolean {
  const lower = key.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern));
}

function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated ${value.length - MAX_STRING_LENGTH}]`
      : value;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return typeof value === 'bigint' ? value.toString() : value;
  }

  if (value instanceof Date) return value.toISOString();

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(value.cause === undefined ? {} : { cause: redact(value.cause, depth + 1, seen) }),
    };
  }

  // Buffers are how key material moves around. Never log the bytes.
  if (Buffer.isBuffer(value)) return `[buffer ${value.length} bytes]`;

  if (depth >= MAX_DEPTH) return '[max depth]';

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redact(item, depth + 1, seen));
    return value.length > MAX_ARRAY_ITEMS
      ? [...items, `…${value.length - MAX_ARRAY_ITEMS} more`]
      : items;
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (keyMatches(key, REDACTED_KEY_PATTERNS)) {
        out[key] = REDACTED;
      } else if (!config.LOG_REQUEST_BODIES && keyMatches(key, PERSONAL_DATA_KEY_PATTERNS)) {
        out[key] = REDACTED_PII;
      } else {
        out[key] = redact(child, depth + 1, seen);
      }
    }
    return out;
  }

  // Functions and symbols have no business in a log line.
  return `[${typeof value}]`;
}

export type LogFields = Record<string, unknown>;

export class Logger {
  private readonly bound: LogFields;

  constructor(bound: LogFields = {}) {
    this.bound = bound;
  }

  /**
   * Returns a logger that stamps every line with these fields. Handlers bind requestId,
   * route and (once authenticated) orgId, so a single Insights query reconstructs an
   * entire request without every call site having to remember to include them.
   */
  child(fields: LogFields): Logger {
    return new Logger({ ...this.bound, ...fields });
  }

  debug(message: string, fields: LogFields = {}): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields: LogFields = {}): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields: LogFields = {}): void {
    this.write('error', message, fields);
  }

  private write(level: LogLevel, message: string, fields: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[config.LOG_LEVEL]) return;

    const line = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...(redact({ ...this.bound, ...fields }) as LogFields),
    };

    // console.error for warn and above so CloudWatch separates them into stderr, which
    // makes "show me only the problems" a filter rather than a search.
    const sink = LEVEL_ORDER[level] >= LEVEL_ORDER.warn ? console.error : console.log;
    sink(JSON.stringify(line));
  }
}

export const logger = new Logger({ environment: config.ENVIRONMENT });

/** Exported for the redaction tests. */
export { redact as redactForTest };
