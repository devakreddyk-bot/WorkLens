/**
 * Turns raw activity events into per-day timesheet rollups.
 *
 * **This module performs no I/O.** No database, no clock, no configuration lookup — everything it
 * needs arrives as an argument. That is not stylistic: the interesting bugs in aggregation are all
 * about time and precedence (DST transitions, sessions crossing midnight, which rule wins), and each
 * of them is a two-line test against a pure function or a half-hour of fixture wrangling against a
 * database. `runner.ts` does the fetching and the upserting.
 *
 * # What it decides
 *
 * - **Which day an event belongs to**, in the *employee's* timezone. See `zone.ts` for why that is
 *   harder than it looks.
 * - **How to split an event that crosses midnight.** A 20-minute sample beginning at 23:50 is ten
 *   minutes on each day, not twenty on one of them.
 * - **Which category and project** a span is attributed to, deterministically.
 *
 * # What it deliberately does not do
 *
 * It does not invent activity. An event's `duration_seconds` is what the agent observed; this module
 * only ever divides that number between days, never rounds it up, and the sum of every rollup's
 * `totalSeconds` equals the sum of the input durations (modulo the second-level rounding documented
 * on `splitAcrossDays`). A timesheet that overstated time would be a payroll problem, not a bug.
 */

import type { LocalDate } from './zone.js';
import { addLocalDays, localDateOf, startOfNextLocalDay } from './zone.js';

/** One activity event, as stored. Field names mirror `activity_events`. */
export interface RollupEvent {
  capturedAt: Date;
  durationSeconds: number;
  isIdle: boolean;
  eventType: string;
  appName: string | null;
  appExe: string | null;
  windowTitle: string | null;
  urlHost: string | null;
}

/** A rule mapping activity to a category. Mirrors `app_categories`. */
export interface CategoryRule {
  id: string;
  matchType: 'app_exe' | 'url_host';
  pattern: string;
  category: string;
  priority: number;
  createdAt: Date;
}

/** A rule mapping activity to a project. Mirrors `project_rules`. */
export interface ProjectRule {
  id: string;
  projectId: string;
  matchType: 'app_exe' | 'url_host' | 'title_contains' | 'title_regex';
  pattern: string;
  priority: number;
  createdAt: Date;
}

export interface RollupOptions {
  /** The employee's IANA timezone. Day boundaries are computed in it. */
  timezone: string;
  categoryRules?: readonly CategoryRule[];
  projectRules?: readonly ProjectRule[];
  /** Screenshot counts per day, since screenshots live in their own table. */
  screenshotCounts?: ReadonlyMap<LocalDate, number>;
  /**
   * Per-match budget for a `title_regex` rule, in milliseconds. A rule that exceeds it is disabled
   * for the remainder of the run — see `matchProject`.
   */
  regexBudgetMs?: number;
  /** Category used when no rule matches. */
  defaultCategory?: string;
}

/** A per-day rollup, ready to upsert into `timesheets` and its child tables. */
export interface DailyRollup {
  workDate: LocalDate;
  timezone: string;
  activeSeconds: number;
  idleSeconds: number;
  totalSeconds: number;
  firstActivityAt: Date | null;
  lastActivityAt: Date | null;
  screenshotCount: number;
  sourceEventCount: number;
  /** Seconds per application name. */
  apps: Record<string, number>;
  /** Seconds per site host. */
  sites: Record<string, number>;
  /** Seconds per category. */
  categories: Record<string, number>;
  /** Seconds per project id. */
  projects: Record<string, number>;
}

/** Diagnostics from a run, for the job's log. Not stored. */
export interface RollupWarnings {
  /**
   * `title_regex` rules that were not applied, by id.
   *
   * Both causes are reported: refused at compile time (pattern too long, a nested quantifier, or
   * not a valid regex) and disabled mid-run (the match threw, or exceeded the budget). Compile-time
   * refusals were originally silent, which meant an owner could save a project rule, have the
   * aggregation ignore it on every run forever, and find nothing anywhere that said so — the rule
   * looked configured and did nothing. A rule that is not being applied is exactly what the job's
   * log is for.
   */
  disabledRegexRules: string[];
  /** Events whose duration was clamped, with the original value. */
  clampedEvents: number;
  /** Events skipped because they carried no usable timestamp. */
  skippedEvents: number;
}

export interface RollupResult {
  rollups: DailyRollup[];
  warnings: RollupWarnings;
}

export const DEFAULT_CATEGORY = 'Uncategorised';
export const DEFAULT_REGEX_BUDGET_MS = 5;

/**
 * The server's CHECK constraint caps `duration_seconds` at 3600, and the agent caps it too. A longer
 * value here means a bug upstream; it is clamped rather than trusted, because a stalled clock could
 * otherwise inject a 40-hour "day" into a payroll export.
 */
const MAX_EVENT_DURATION_SECONDS = 3600;

/** Longest `title_regex` pattern compiled. A longer one is a mistake, not a rule. */
const MAX_REGEX_PATTERN_LENGTH = 400;

/** Window titles are truncated before regex matching, bounding the cost of a bad pattern. */
const MAX_REGEX_INPUT_LENGTH = 500;

/**
 * Detects a quantifier applied to a group that already contains one: `(a+)+`, `(x*)*`, `(\d+)*`.
 *
 * This is the shape that backtracks catastrophically, and screening for it is the only mitigation
 * that actually works. The alternative — measuring how long a match took and disabling the rule
 * afterwards — is what this code originally did, and it is close to useless: a single `(a+)+$` match
 * against a 40-character non-matching subject takes about **95 seconds**, so the "budget" is only
 * consulted long after the aggregation Lambda has blown its 300-second timeout. Measured, not
 * assumed; the test that demonstrated it is in test/aggregation/rollup.test.ts.
 *
 * JavaScript cannot interrupt a running regular expression, so there is no way to bound one from the
 * outside. Refusing to compile the dangerous shape is the defence.
 *
 * It is a heuristic, and deliberately a conservative one: deciding in general whether a pattern
 * backtracks catastrophically is not tractable, so this catches the common constructions and lets
 * exotic ones through. The remaining defences are the input-length cap and the server refusing to
 * store such a pattern in the first place.
 */
const NESTED_QUANTIFIER_RE = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/;

/**
 * Aggregates events into per-day rollups.
 *
 * Events need not be sorted; days with no activity produce no rollup. The caller decides whether a
 * day with no events should be written as a row of zeros — `runner.ts` does not, because an empty
 * timesheet and a missing one carry different meanings on a dashboard.
 */
export function aggregate(
  events: readonly RollupEvent[],
  options: RollupOptions,
): RollupResult {
  const timezone = options.timezone;
  const defaultCategory = options.defaultCategory ?? DEFAULT_CATEGORY;
  const regexBudgetMs = options.regexBudgetMs ?? DEFAULT_REGEX_BUDGET_MS;

  const categoryRules = sortRules(options.categoryRules ?? []);
  const projectRules = sortRules(options.projectRules ?? []);

  const warnings: RollupWarnings = {
    disabledRegexRules: [],
    clampedEvents: 0,
    skippedEvents: 0,
  };

  // After `warnings`, because compilation reports the rules it refuses.
  const compiled = compileRegexRules(projectRules, warnings);

  const days = new Map<LocalDate, MutableRollup>();

  for (const event of events) {
    if (!(event.capturedAt instanceof Date) || Number.isNaN(event.capturedAt.getTime())) {
      // A row that cannot be placed on a calendar cannot be aggregated. Counted rather than thrown:
      // one bad row must not discard an entire month's timesheets.
      warnings.skippedEvents += 1;
      continue;
    }

    let duration = event.durationSeconds;
    if (!Number.isFinite(duration) || duration < 0) {
      duration = 0;
    }
    if (duration > MAX_EVENT_DURATION_SECONDS) {
      duration = MAX_EVENT_DURATION_SECONDS;
      warnings.clampedEvents += 1;
    }

    // Attribution is resolved once per event, not once per day-slice, so a split event is
    // attributed identically on both sides of midnight.
    const category = event.isIdle ? null : matchCategory(event, categoryRules, defaultCategory);
    const projectId = event.isIdle
      ? null
      : matchProject(event, compiled, regexBudgetMs, warnings);

    for (const slice of splitAcrossDays(event.capturedAt, duration, timezone)) {
      const day = dayFor(days, slice.date, timezone);
      day.sourceEventCount += 1;

      if (event.isIdle) {
        day.idleSeconds += slice.seconds;
        // Idle time is attributed to nothing: no app, no site, no category, no project. Enforced in
        // the schema too, and repeated here so a rollup cannot contradict it.
        continue;
      }

      day.activeSeconds += slice.seconds;

      if (event.appName !== null && event.appName !== '') {
        addSeconds(day.apps, event.appName, slice.seconds);
      }
      if (event.urlHost !== null && event.urlHost !== '') {
        addSeconds(day.sites, event.urlHost, slice.seconds);
      }
      if (category !== null) {
        addSeconds(day.categories, category, slice.seconds);
      }
      if (projectId !== null) {
        addSeconds(day.projects, projectId, slice.seconds);
      }

      // First and last activity track real activity only: a day of nothing but idle samples has no
      // first activity, which is more honest on a timesheet than reporting the moment the laptop
      // was left unattended.
      const sliceStart = slice.start;
      const sliceEnd = new Date(slice.start.getTime() + slice.seconds * 1000);
      if (day.firstActivityAt === null || sliceStart < day.firstActivityAt) {
        day.firstActivityAt = sliceStart;
      }
      if (day.lastActivityAt === null || sliceEnd > day.lastActivityAt) {
        day.lastActivityAt = sliceEnd;
      }
    }
  }

  const rollups: DailyRollup[] = [];
  for (const [workDate, day] of [...days.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    rollups.push({
      workDate,
      timezone,
      activeSeconds: day.activeSeconds,
      idleSeconds: day.idleSeconds,
      // Computed rather than accumulated, so it cannot drift from its parts — the schema's
      // timesheets_totals_chk enforces the same identity.
      totalSeconds: day.activeSeconds + day.idleSeconds,
      firstActivityAt: day.firstActivityAt,
      lastActivityAt: day.lastActivityAt,
      screenshotCount: options.screenshotCounts?.get(workDate) ?? 0,
      sourceEventCount: day.sourceEventCount,
      apps: day.apps,
      sites: day.sites,
      categories: day.categories,
      projects: day.projects,
    });
  }

  return { rollups, warnings };
}

interface MutableRollup {
  activeSeconds: number;
  idleSeconds: number;
  firstActivityAt: Date | null;
  lastActivityAt: Date | null;
  sourceEventCount: number;
  apps: Record<string, number>;
  sites: Record<string, number>;
  categories: Record<string, number>;
  projects: Record<string, number>;
}

function dayFor(
  days: Map<LocalDate, MutableRollup>,
  date: LocalDate,
  _timezone: string,
): MutableRollup {
  let day = days.get(date);
  if (day === undefined) {
    day = {
      activeSeconds: 0,
      idleSeconds: 0,
      firstActivityAt: null,
      lastActivityAt: null,
      sourceEventCount: 0,
      apps: {},
      sites: {},
      categories: {},
      projects: {},
    };
    days.set(date, day);
  }
  return day;
}

function addSeconds(target: Record<string, number>, key: string, seconds: number): void {
  target[key] = (target[key] ?? 0) + seconds;
}

interface DaySlice {
  date: LocalDate;
  start: Date;
  seconds: number;
}

/**
 * Divides an event's duration between the local days it spans.
 *
 * A sample beginning at 23:50 with a 20-minute duration is ten minutes on each day. Attributing all
 * twenty to the starting day would be simpler and would overstate one day while understating the
 * next — which on a Monday/Sunday boundary means billing weekend hours to a weekday.
 *
 * Rounding: each slice is rounded to whole seconds and the final slice absorbs the remainder, so the
 * slices always sum exactly to the input duration. Distributing the rounding error instead would let
 * a day's total drift from the events that produced it.
 *
 * A zero-duration event still produces one slice, because it belongs to a day and counts toward that
 * day's `source_event_count` — a session marker is a fact about a day even though it consumes no
 * time.
 */
export function splitAcrossDays(start: Date, durationSeconds: number, timezone: string): DaySlice[] {
  const startDate = localDateOf(start, timezone);

  if (durationSeconds <= 0) {
    return [{ date: startDate, start, seconds: 0 }];
  }

  const endMs = start.getTime() + durationSeconds * 1000;
  const slices: DaySlice[] = [];

  let cursor = start;
  let cursorDate = startDate;
  let allocated = 0;

  // Bounded: the duration is clamped to an hour upstream, so this can iterate at most twice in
  // practice. The guard is against a future caller passing something larger.
  for (let guard = 0; guard < 64; guard += 1) {
    const boundary = startOfNextLocalDay(cursorDate, timezone);
    const sliceEndMs = Math.min(endMs, boundary.getTime());
    const seconds = Math.round((sliceEndMs - cursor.getTime()) / 1000);

    const isFinal = sliceEndMs >= endMs;
    // The last slice takes whatever is left, so rounding cannot lose or invent a second.
    const allocatedSeconds = isFinal ? durationSeconds - allocated : seconds;

    if (allocatedSeconds > 0 || slices.length === 0) {
      slices.push({ date: cursorDate, start: cursor, seconds: allocatedSeconds });
      allocated += allocatedSeconds;
    }

    if (isFinal) return slices;

    cursor = boundary;
    cursorDate = addLocalDays(cursorDate, 1);
  }

  throw new Error(
    `aggregation: an event starting ${start.toISOString()} with duration ${durationSeconds}s ` +
      `spans more than 64 days in ${timezone}; refusing to continue`,
  );
}

/**
 * Orders rules deterministically: lowest priority number first, then oldest, then by id.
 *
 * All three keys are needed. Priority alone leaves ties, and a tie broken by whatever order the
 * database happened to return rows in would make a re-run of the same day produce different
 * attribution — which is indefensible on a timesheet somebody has signed off.
 */
function sortRules<T extends { priority: number; createdAt: Date; id: string }>(
  rules: readonly T[],
): T[] {
  return [...rules].sort(
    (a, b) =>
      a.priority - b.priority ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id),
  );
}

/** Case-insensitive substring match, the semantics a deployer expects from a pattern. */
function containsInsensitive(haystack: string | null, needle: string): boolean {
  if (haystack === null || haystack === '') return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Returns the category for an event: the first matching rule wins.
 *
 * `app_exe` is matched against both the executable path and the application name, because a rule
 * written as "chrome" should match whether the deployer was thinking of the name or the path.
 */
export function matchCategory(
  event: RollupEvent,
  sortedRules: readonly CategoryRule[],
  defaultCategory: string,
): string {
  for (const rule of sortedRules) {
    if (rule.matchType === 'app_exe') {
      if (containsInsensitive(event.appExe, rule.pattern) || containsInsensitive(event.appName, rule.pattern)) {
        return rule.category;
      }
      continue;
    }
    if (containsInsensitive(event.urlHost, rule.pattern)) {
      return rule.category;
    }
  }
  return defaultCategory;
}

interface CompiledProjectRule {
  rule: ProjectRule;
  regex: RegExp | null;
  /** Set when the rule has been disabled for the rest of the run. */
  disabled: boolean;
}

/**
 * Compiles `title_regex` patterns once per run rather than once per event.
 *
 * An invalid pattern disables its rule rather than failing the run. The server validates patterns on
 * write, so an invalid one here means a bug or an older row — and losing a night's timesheets over
 * one bad rule would be a worse outcome than losing that rule's attribution.
 */
function compileRegexRules(
  sortedRules: readonly ProjectRule[],
  warnings: RollupWarnings,
): CompiledProjectRule[] {
  return sortedRules.map((rule) => {
    if (rule.matchType !== 'title_regex') {
      return { rule, regex: null, disabled: false };
    }

    const refuse = (): CompiledProjectRule => {
      // Recorded, not just skipped. A rule the aggregation silently declines to apply is
      // indistinguishable, from the dashboard, from a rule that matches nothing.
      warnings.disabledRegexRules.push(rule.id);
      return { rule, regex: null, disabled: true };
    };

    if (rule.pattern.length > MAX_REGEX_PATTERN_LENGTH) {
      return refuse();
    }

    // Refused before it can run. See NESTED_QUANTIFIER_RE: a post-hoc time budget cannot help,
    // because the first match has already taken longer than the whole job is allowed.
    if (NESTED_QUANTIFIER_RE.test(rule.pattern)) {
      return refuse();
    }

    try {
      // No global flag: a stateful lastIndex across events would make matching depend on the order
      // events happened to arrive in.
      return { rule, regex: new RegExp(rule.pattern, 'i'), disabled: false };
    } catch {
      return refuse();
    }
  });
}

/**
 * Returns the project id for an event, or null.
 *
 * # Bounding a hostile pattern
 *
 * JavaScript cannot interrupt a running regular expression, which makes the obvious mitigation —
 * time the match and disable the rule if it was slow — almost worthless. A single `(a+)+$` against a
 * 40-character non-matching subject takes roughly 95 seconds, so the budget would first be consulted
 * long after the Lambda's 300-second timeout had already killed the job. That was measured, not
 * reasoned about.
 *
 * So the defences are, in order of what actually does the work:
 *
 *  1. **Nested quantifiers are refused at compile time** (NESTED_QUANTIFIER_RE). This is the one
 *     that matters: the pattern never runs.
 *  2. Patterns longer than 400 characters are never compiled.
 *  3. Titles are truncated to 500 characters, bounding the input.
 *  4. The time budget remains as a backstop for a slow pattern that is not catastrophic — it
 *     disables the rule for the rest of the run, so one bad pattern costs one slow match rather
 *     than one per event across a month of data.
 *
 * Even so, (1) is a heuristic and the real defence is the server refusing to store such a pattern.
 */
export function matchProject(
  event: RollupEvent,
  compiled: readonly CompiledProjectRule[],
  regexBudgetMs: number,
  warnings: RollupWarnings,
): string | null {
  for (const entry of compiled) {
    if (entry.disabled) continue;
    const { rule } = entry;

    switch (rule.matchType) {
      case 'app_exe':
        if (containsInsensitive(event.appExe, rule.pattern) || containsInsensitive(event.appName, rule.pattern)) {
          return rule.projectId;
        }
        break;

      case 'url_host':
        if (containsInsensitive(event.urlHost, rule.pattern)) {
          return rule.projectId;
        }
        break;

      case 'title_contains':
        if (containsInsensitive(event.windowTitle, rule.pattern)) {
          return rule.projectId;
        }
        break;

      case 'title_regex': {
        if (entry.regex === null || event.windowTitle === null || event.windowTitle === '') break;

        const subject = event.windowTitle.slice(0, MAX_REGEX_INPUT_LENGTH);
        const started = performance.now();
        let matched = false;
        try {
          matched = entry.regex.test(subject);
        } catch {
          entry.disabled = true;
          warnings.disabledRegexRules.push(rule.id);
          break;
        }
        const elapsed = performance.now() - started;

        if (elapsed > regexBudgetMs) {
          entry.disabled = true;
          warnings.disabledRegexRules.push(rule.id);
        }
        if (matched) return rule.projectId;
        break;
      }
    }
  }

  return null;
}

/**
 * Checks a rollup against its own day.
 *
 * A day's recorded total cannot exceed the length of that day — 82 800 seconds on a spring-forward
 * day, 90 000 on a fall-back day, 86 400 otherwise. Exceeding it means the arithmetic is wrong, and
 * catching that here is the difference between a caught bug and an implausible payroll export.
 *
 * Returned rather than thrown: the caller logs it and still writes the row, because a timesheet that
 * is too large is more useful to investigate than one that is missing.
 */
export function implausible(rollup: DailyRollup, dayLengthSeconds: number): string | null {
  if (rollup.totalSeconds > dayLengthSeconds) {
    return `total ${rollup.totalSeconds}s exceeds the ${dayLengthSeconds}s length of ${rollup.workDate}`;
  }
  if (rollup.activeSeconds < 0 || rollup.idleSeconds < 0) {
    return `negative seconds on ${rollup.workDate}`;
  }
  if (rollup.totalSeconds !== rollup.activeSeconds + rollup.idleSeconds) {
    return `total ${rollup.totalSeconds}s does not equal active + idle on ${rollup.workDate}`;
  }

  for (const [label, buckets] of [
    ['apps', rollup.apps],
    ['sites', rollup.sites],
    ['categories', rollup.categories],
    ['projects', rollup.projects],
  ] as const) {
    const summed = Object.values(buckets).reduce((total, seconds) => total + seconds, 0);
    if (summed > rollup.activeSeconds) {
      // A per-bucket total above active time means an event was counted twice.
      return `${label} sum ${summed}s exceeds active ${rollup.activeSeconds}s on ${rollup.workDate}`;
    }
  }

  return null;
}
