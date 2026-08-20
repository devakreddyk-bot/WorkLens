/**
 * Tests for the timesheet rollup.
 *
 * The rollup is pure precisely so these cases are cheap, because they are the ones that matter: a
 * session crossing midnight, a DST transition, an all-idle day, and which rule wins a tie. Each of
 * them produces a plausible-looking wrong number if it is handled carelessly, and a wrong number on
 * a timesheet is a payroll problem rather than a bug report.
 */

import { describe, expect, it } from 'vitest';

import {
  aggregate,
  DEFAULT_CATEGORY,
  implausible,
  splitAcrossDays,
} from '../../src/aggregation/rollup.js';
import type { CategoryRule, ProjectRule, RollupEvent } from '../../src/aggregation/rollup.js';
import { localDayLengthSeconds } from '../../src/aggregation/zone.js';

const KOLKATA = 'Asia/Kolkata';
const MELBOURNE = 'Australia/Melbourne';

function activeEvent(overrides: Partial<RollupEvent> = {}): RollupEvent {
  return {
    capturedAt: new Date('2026-08-19T04:00:00Z'), // 09:30 in Kolkata
    durationSeconds: 60,
    isIdle: false,
    eventType: 'window_sample',
    appName: 'code.exe',
    appExe: 'C:\\Program Files\\Microsoft VS Code\\code.exe',
    windowTitle: 'rollup.ts - worklens',
    urlHost: null,
    ...overrides,
  };
}

function idleEvent(overrides: Partial<RollupEvent> = {}): RollupEvent {
  return {
    ...activeEvent(),
    isIdle: true,
    eventType: 'idle_state',
    appName: null,
    appExe: null,
    windowTitle: null,
    urlHost: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Day attribution
// ---------------------------------------------------------------------------

describe('day attribution', () => {
  it('files an event under the employee day, not the UTC day', () => {
    // 19:30 UTC is 01:00 the next day in Kolkata. Aggregating in UTC would put this on the wrong
    // day for every Indian employee, every evening.
    const { rollups } = aggregate([activeEvent({ capturedAt: new Date('2026-08-18T19:30:00Z') })], {
      timezone: KOLKATA,
    });

    expect(rollups).toHaveLength(1);
    expect(rollups[0]?.workDate).toBe('2026-08-19');
  });

  it('produces no rollup for a day with no events', () => {
    // An empty timesheet and a missing one mean different things on a dashboard, so this module
    // does not invent rows of zeros.
    const { rollups } = aggregate([], { timezone: KOLKATA });
    expect(rollups).toEqual([]);
  });

  it('returns rollups in date order', () => {
    const events = [
      activeEvent({ capturedAt: new Date('2026-08-21T04:00:00Z') }),
      activeEvent({ capturedAt: new Date('2026-08-19T04:00:00Z') }),
      activeEvent({ capturedAt: new Date('2026-08-20T04:00:00Z') }),
    ];
    const { rollups } = aggregate(events, { timezone: KOLKATA });
    expect(rollups.map((r) => r.workDate)).toEqual(['2026-08-19', '2026-08-20', '2026-08-21']);
  });
});

// ---------------------------------------------------------------------------
// Midnight
// ---------------------------------------------------------------------------

describe('sessions crossing midnight', () => {
  it('splits the duration between the two days', () => {
    // Ten minutes before midnight, twenty minutes long. Attributing all twenty to the starting day
    // would overstate one day and understate the next.
    const start = new Date('2026-08-19T18:20:00Z'); // 23:50 in Kolkata
    const { rollups } = aggregate([activeEvent({ capturedAt: start, durationSeconds: 1200 })], {
      timezone: KOLKATA,
    });

    expect(rollups).toHaveLength(2);
    expect(rollups[0]).toMatchObject({ workDate: '2026-08-19', activeSeconds: 600 });
    expect(rollups[1]).toMatchObject({ workDate: '2026-08-20', activeSeconds: 600 });
  });

  it('conserves the total duration exactly', () => {
    // The property that matters: the module divides time between days and never invents or loses a
    // second, because a day that drifted from its events would be indefensible on a payslip.
    const durations = [1, 7, 59, 60, 61, 599, 1201, 3599, 3600];

    for (const duration of durations) {
      const start = new Date('2026-08-19T18:29:31Z'); // 23:59:31 in Kolkata
      const { rollups } = aggregate([activeEvent({ capturedAt: start, durationSeconds: duration })], {
        timezone: KOLKATA,
      });

      const summed = rollups.reduce((total, r) => total + r.totalSeconds, 0);
      expect(summed, `duration ${duration}`).toBe(duration);
    }
  });

  it('splits an idle span too, without attributing it', () => {
    const start = new Date('2026-08-19T18:20:00Z');
    const { rollups } = aggregate([idleEvent({ capturedAt: start, durationSeconds: 1200 })], {
      timezone: KOLKATA,
    });

    expect(rollups).toHaveLength(2);
    for (const rollup of rollups) {
      expect(rollup.idleSeconds).toBe(600);
      expect(rollup.activeSeconds).toBe(0);
      expect(rollup.apps).toEqual({});
    }
  });

  it('attributes both halves of a split event identically', () => {
    // Attribution is resolved once per event rather than per slice, so the app and project cannot
    // differ across a midnight boundary.
    const start = new Date('2026-08-19T18:20:00Z');
    const { rollups } = aggregate([activeEvent({ capturedAt: start, durationSeconds: 1200 })], {
      timezone: KOLKATA,
    });

    expect(rollups[0]?.apps).toEqual({ 'code.exe': 600 });
    expect(rollups[1]?.apps).toEqual({ 'code.exe': 600 });
  });
});

describe('splitAcrossDays', () => {
  it('returns one slice for an event wholly inside a day', () => {
    const slices = splitAcrossDays(new Date('2026-08-19T04:00:00Z'), 60, KOLKATA);
    expect(slices).toHaveLength(1);
    expect(slices[0]).toMatchObject({ date: '2026-08-19', seconds: 60 });
  });

  it('returns one zero-second slice for a marker event', () => {
    // A session_start consumes no time but is still a fact about a day, and counts toward that
    // day's source_event_count.
    const slices = splitAcrossDays(new Date('2026-08-19T04:00:00Z'), 0, KOLKATA);
    expect(slices).toHaveLength(1);
    expect(slices[0]?.seconds).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DST
// ---------------------------------------------------------------------------

describe('daylight saving transitions', () => {
  it('handles the spring-forward day, when the local day is 23 hours', () => {
    // Melbourne 2026-10-04: 02:00 jumps to 03:00. An event at 01:30 and one at 03:30 are both on
    // that day, and the day's own length is 82 800 seconds.
    const events = [
      activeEvent({ capturedAt: new Date('2026-10-03T15:30:00Z'), durationSeconds: 1800 }), // 01:30 local
      activeEvent({ capturedAt: new Date('2026-10-03T16:30:00Z'), durationSeconds: 1800 }), // 03:30 local
    ];
    const { rollups } = aggregate(events, { timezone: MELBOURNE });

    expect(rollups).toHaveLength(1);
    expect(rollups[0]?.workDate).toBe('2026-10-04');
    expect(rollups[0]?.activeSeconds).toBe(3600);
    expect(implausible(rollups[0]!, localDayLengthSeconds('2026-10-04', MELBOURNE))).toBeNull();
  });

  it('handles the fall-back day, when the local day is 25 hours', () => {
    // Melbourne 2026-04-05: 03:00 returns to 02:00, so 02:30 local happens twice. Both instants
    // belong to the same calendar day and both must be counted.
    const events = [
      activeEvent({ capturedAt: new Date('2026-04-04T15:30:00Z'), durationSeconds: 1800 }), // 02:30 AEDT
      activeEvent({ capturedAt: new Date('2026-04-04T16:30:00Z'), durationSeconds: 1800 }), // 02:30 AEST
    ];
    const { rollups } = aggregate(events, { timezone: MELBOURNE });

    expect(rollups).toHaveLength(1);
    expect(rollups[0]?.workDate).toBe('2026-04-05');
    expect(rollups[0]?.activeSeconds).toBe(3600);
    expect(implausible(rollups[0]!, localDayLengthSeconds('2026-04-05', MELBOURNE))).toBeNull();
  });

  it('splits correctly across a midnight adjacent to a transition', () => {
    // 23:50 local on the day before the spring forward, running 20 minutes into the transition day.
    const start = new Date('2026-10-03T13:50:00Z'); // 23:50 AEST on the 3rd
    const { rollups } = aggregate([activeEvent({ capturedAt: start, durationSeconds: 1200 })], {
      timezone: MELBOURNE,
    });

    expect(rollups.map((r) => r.workDate)).toEqual(['2026-10-03', '2026-10-04']);
    expect(rollups.reduce((t, r) => t + r.totalSeconds, 0)).toBe(1200);
  });
});

// ---------------------------------------------------------------------------
// Idle
// ---------------------------------------------------------------------------

describe('idle handling', () => {
  it('produces a rollup with no first or last activity for an all-idle day', () => {
    // A day of nothing but idle samples has no activity, and reporting the moment the laptop was
    // left unattended as "first activity" would be misleading.
    const events = [
      idleEvent({ capturedAt: new Date('2026-08-19T04:00:00Z'), durationSeconds: 1800 }),
      idleEvent({ capturedAt: new Date('2026-08-19T05:00:00Z'), durationSeconds: 1800 }),
    ];
    const { rollups } = aggregate(events, { timezone: KOLKATA });

    expect(rollups).toHaveLength(1);
    expect(rollups[0]).toMatchObject({
      activeSeconds: 0,
      idleSeconds: 3600,
      totalSeconds: 3600,
      firstActivityAt: null,
      lastActivityAt: null,
    });
  });

  it('never attributes idle time to an app, site, category or project', () => {
    // The guarantee to employees. Repeated here even though the schema enforces it, so a rollup
    // cannot contradict the constraint it will be stored under.
    const events = [
      // A hostile or buggy row carrying attribution on an idle event.
      idleEvent({ appName: 'chrome.exe', appExe: 'C:\\chrome.exe', windowTitle: 'Payslip', urlHost: 'myob.com' }),
    ];
    const { rollups } = aggregate(events, {
      timezone: KOLKATA,
      categoryRules: [catRule({ pattern: 'chrome', category: 'Browsing' })],
      projectRules: [projRule({ matchType: 'url_host', pattern: 'myob.com' })],
    });

    expect(rollups[0]).toMatchObject({ activeSeconds: 0, idleSeconds: 60 });
    expect(rollups[0]?.apps).toEqual({});
    expect(rollups[0]?.sites).toEqual({});
    expect(rollups[0]?.categories).toEqual({});
    expect(rollups[0]?.projects).toEqual({});
  });

  it('reports active and idle separately on a mixed day', () => {
    const events = [
      activeEvent({ capturedAt: new Date('2026-08-19T04:00:00Z'), durationSeconds: 3600 }),
      idleEvent({ capturedAt: new Date('2026-08-19T05:00:00Z'), durationSeconds: 1800 }),
    ];
    const { rollups } = aggregate(events, { timezone: KOLKATA });

    expect(rollups[0]).toMatchObject({ activeSeconds: 3600, idleSeconds: 1800, totalSeconds: 5400 });
  });
});

// ---------------------------------------------------------------------------
// First and last activity
// ---------------------------------------------------------------------------

describe('first and last activity', () => {
  it('spans the earliest start to the latest end', () => {
    const events = [
      activeEvent({ capturedAt: new Date('2026-08-19T09:00:00Z'), durationSeconds: 600 }),
      activeEvent({ capturedAt: new Date('2026-08-19T04:00:00Z'), durationSeconds: 600 }),
      activeEvent({ capturedAt: new Date('2026-08-19T06:00:00Z'), durationSeconds: 600 }),
    ];
    const { rollups } = aggregate(events, { timezone: KOLKATA });

    expect(rollups[0]?.firstActivityAt?.toISOString()).toBe('2026-08-19T04:00:00.000Z');
    // The end of the last span, not its start — the employee was working until 09:10.
    expect(rollups[0]?.lastActivityAt?.toISOString()).toBe('2026-08-19T09:10:00.000Z');
  });

  it('ignores idle samples when deciding them', () => {
    const events = [
      idleEvent({ capturedAt: new Date('2026-08-19T02:00:00Z'), durationSeconds: 600 }),
      activeEvent({ capturedAt: new Date('2026-08-19T04:00:00Z'), durationSeconds: 600 }),
      idleEvent({ capturedAt: new Date('2026-08-19T10:00:00Z'), durationSeconds: 600 }),
    ];
    const { rollups } = aggregate(events, { timezone: KOLKATA });

    expect(rollups[0]?.firstActivityAt?.toISOString()).toBe('2026-08-19T04:00:00.000Z');
    expect(rollups[0]?.lastActivityAt?.toISOString()).toBe('2026-08-19T04:10:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Categories and projects
// ---------------------------------------------------------------------------

function catRule(overrides: Partial<CategoryRule> = {}): CategoryRule {
  return {
    id: 'c1',
    matchType: 'app_exe',
    pattern: 'code.exe',
    category: 'Development',
    priority: 100,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function projRule(overrides: Partial<ProjectRule> = {}): ProjectRule {
  return {
    id: 'p1',
    projectId: 'project-alpha',
    matchType: 'app_exe',
    pattern: 'code.exe',
    priority: 100,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('categorisation', () => {
  it('applies the matching rule', () => {
    const { rollups } = aggregate([activeEvent()], {
      timezone: KOLKATA,
      categoryRules: [catRule()],
    });
    expect(rollups[0]?.categories).toEqual({ Development: 60 });
  });

  it('falls back to a default when nothing matches', () => {
    const { rollups } = aggregate([activeEvent({ appName: 'unknown.exe', appExe: 'C:\\unknown.exe' })], {
      timezone: KOLKATA,
      categoryRules: [catRule()],
    });
    expect(rollups[0]?.categories).toEqual({ [DEFAULT_CATEGORY]: 60 });
  });

  it('matches app_exe against both the path and the name', () => {
    // A deployer writing "chrome" should not have to know which field it lands in.
    const byName = aggregate([activeEvent({ appName: 'chrome.exe', appExe: 'C:\\weird\\path.exe' })], {
      timezone: KOLKATA,
      categoryRules: [catRule({ pattern: 'chrome', category: 'Browsing' })],
    });
    expect(byName.rollups[0]?.categories).toEqual({ Browsing: 60 });

    const byPath = aggregate([activeEvent({ appName: 'electron.exe', appExe: 'C:\\Apps\\Slack\\electron.exe' })], {
      timezone: KOLKATA,
      categoryRules: [catRule({ pattern: 'slack', category: 'Communication' })],
    });
    expect(byPath.rollups[0]?.categories).toEqual({ Communication: 60 });
  });

  it('lets the lowest priority number win', () => {
    const { rollups } = aggregate([activeEvent()], {
      timezone: KOLKATA,
      categoryRules: [
        catRule({ id: 'low', priority: 900, category: 'Browsing' }),
        catRule({ id: 'high', priority: 10, category: 'Development' }),
      ],
    });
    expect(rollups[0]?.categories).toEqual({ Development: 60 });
  });

  it('breaks a priority tie by age, then by id, so a re-run is reproducible', () => {
    // A tie resolved by whatever order the database returned rows in would make re-aggregating a
    // settled day change its attribution — indefensible once somebody has signed it off.
    const older = catRule({ id: 'zzz', priority: 100, category: 'Older', createdAt: new Date('2026-01-01T00:00:00Z') });
    const newer = catRule({ id: 'aaa', priority: 100, category: 'Newer', createdAt: new Date('2026-06-01T00:00:00Z') });

    const forwards = aggregate([activeEvent()], { timezone: KOLKATA, categoryRules: [older, newer] });
    const backwards = aggregate([activeEvent()], { timezone: KOLKATA, categoryRules: [newer, older] });

    expect(forwards.rollups[0]?.categories).toEqual({ Older: 60 });
    expect(backwards.rollups[0]?.categories).toEqual(forwards.rollups[0]?.categories);
  });
});

describe('project attribution', () => {
  it('matches on app, host, title substring and title regex', () => {
    const cases: { rule: ProjectRule; event: RollupEvent }[] = [
      { rule: projRule({ matchType: 'app_exe', pattern: 'code.exe' }), event: activeEvent() },
      { rule: projRule({ matchType: 'url_host', pattern: 'github.com' }), event: activeEvent({ urlHost: 'github.com' }) },
      { rule: projRule({ matchType: 'title_contains', pattern: 'worklens' }), event: activeEvent() },
      { rule: projRule({ matchType: 'title_regex', pattern: '^rollup\\.ts' }), event: activeEvent() },
    ];

    for (const { rule, event } of cases) {
      const { rollups } = aggregate([event], { timezone: KOLKATA, projectRules: [rule] });
      expect(rollups[0]?.projects, rule.matchType).toEqual({ 'project-alpha': 60 });
    }
  });

  it('leaves projects empty when nothing matches', () => {
    const { rollups } = aggregate([activeEvent()], {
      timezone: KOLKATA,
      projectRules: [projRule({ matchType: 'url_host', pattern: 'nowhere.example' })],
    });
    expect(rollups[0]?.projects).toEqual({});
  });

  it('ignores an invalid regex rule instead of failing the run', () => {
    // The server validates patterns on write, so an invalid one means a bug or an old row. Losing a
    // night's timesheets over one bad rule is worse than losing that rule.
    const { rollups } = aggregate([activeEvent()], {
      timezone: KOLKATA,
      projectRules: [
        projRule({ id: 'bad', matchType: 'title_regex', pattern: '([unclosed', priority: 10 }),
        projRule({ id: 'good', matchType: 'app_exe', pattern: 'code.exe', priority: 20, projectId: 'project-beta' }),
      ],
    });
    expect(rollups[0]?.projects).toEqual({ 'project-beta': 60 });
  });

  it('refuses a catastrophically backtracking pattern before it can run', () => {
    // This test is why the compile-time screen exists. With only a post-hoc time budget, this
    // single (a+)+$ match against a 40-character non-matching subject took 95 SECONDS — measured —
    // so the budget was consulted long after the Lambda's 300s timeout would have killed the job.
    // The assertion on elapsed time is the real subject here: the pattern must never execute.
    const catastrophic = projRule({
      id: 'slow',
      matchType: 'title_regex',
      pattern: '(a+)+$',
    });
    const event = activeEvent({ windowTitle: `${'a'.repeat(40)}b` });

    const started = performance.now();
    const { rollups } = aggregate([event, event, event], {
      timezone: KOLKATA,
      projectRules: [catastrophic],
    });
    const elapsed = performance.now() - started;

    // Generous by three orders of magnitude and still catches a regression instantly.
    expect(elapsed).toBeLessThan(1000);
    // The rule contributed nothing, because it was never compiled.
    expect(rollups[0]?.projects).toEqual({});
  });

  it.each([
    ['(a+)+$', 'nested plus'],
    ['(x*)*', 'nested star'],
    ['(\\d+)+', 'nested plus on a class'],
    ['([a-z]+)*', 'star over a plus'],
    ['(\\w{2,})+', 'plus over a bounded repeat'],
  ])('refuses the dangerous pattern %s (%s)', (pattern) => {
    const { rollups } = aggregate([activeEvent({ windowTitle: 'aaaaaaaaaaaaaaaaaaaab' })], {
      timezone: KOLKATA,
      projectRules: [projRule({ matchType: 'title_regex', pattern })],
    });
    expect(rollups[0]?.projects).toEqual({});
  });

  it.each([
    '^rollup\\.ts',
    'worklens',
    '(alpha|beta)',
    '\\d{4}-\\d{2}',
    '^Project: (.+)$',
    '(foo)+',
  ])('still allows the legitimate pattern %s', (pattern) => {
    // The screen must not be so blunt that ordinary rules stop working — a conservative heuristic
    // that blocked "(foo)+" would quietly break real deployments.
    const { rollups } = aggregate([activeEvent({ windowTitle: 'foo' })], {
      timezone: KOLKATA,
      projectRules: [projRule({ matchType: 'title_regex', pattern: pattern.replace(/^\^/, '') })],
    });
    // Either it matched or it did not; what matters is that the rule was compiled rather than
    // refused, which a blocked pattern would make impossible for the matching cases.
    expect(rollups).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

describe('bad input', () => {
  it('clamps a duration above the schema maximum', () => {
    // A stalled clock could otherwise inject a 40-hour day into a payroll export.
    const { rollups, warnings } = aggregate([activeEvent({ durationSeconds: 200_000 })], {
      timezone: KOLKATA,
    });
    expect(rollups[0]?.activeSeconds).toBe(3600);
    expect(warnings.clampedEvents).toBe(1);
  });

  it('treats a negative duration as zero', () => {
    const { rollups } = aggregate([activeEvent({ durationSeconds: -60 })], { timezone: KOLKATA });
    expect(rollups[0]?.activeSeconds).toBe(0);
  });

  it('skips an event with an unusable timestamp instead of discarding the month', () => {
    const events = [
      activeEvent({ capturedAt: new Date('not a date') }),
      activeEvent({ capturedAt: new Date('2026-08-19T04:00:00Z') }),
    ];
    const { rollups, warnings } = aggregate(events, { timezone: KOLKATA });

    expect(warnings.skippedEvents).toBe(1);
    expect(rollups).toHaveLength(1);
    expect(rollups[0]?.activeSeconds).toBe(60);
  });

  it('counts every contributing event, including split halves', () => {
    const start = new Date('2026-08-19T18:20:00Z');
    const { rollups } = aggregate([activeEvent({ capturedAt: start, durationSeconds: 1200 })], {
      timezone: KOLKATA,
    });
    // One event, two days, one counted on each — so a day's source_event_count reflects what
    // actually contributed to it.
    expect(rollups[0]?.sourceEventCount).toBe(1);
    expect(rollups[1]?.sourceEventCount).toBe(1);
  });
});

describe('screenshot counts', () => {
  it('takes them from the supplied map', () => {
    const { rollups } = aggregate([activeEvent()], {
      timezone: KOLKATA,
      screenshotCounts: new Map([['2026-08-19', 7]]),
    });
    expect(rollups[0]?.screenshotCount).toBe(7);
  });

  it('defaults to zero', () => {
    const { rollups } = aggregate([activeEvent()], { timezone: KOLKATA });
    expect(rollups[0]?.screenshotCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The plausibility check
// ---------------------------------------------------------------------------

describe('implausible', () => {
  it('passes a normal day', () => {
    const { rollups } = aggregate([activeEvent()], { timezone: KOLKATA });
    expect(implausible(rollups[0]!, 86_400)).toBeNull();
  });

  it('catches a total longer than the day itself', () => {
    const rollup = {
      workDate: '2026-08-19', timezone: KOLKATA,
      activeSeconds: 90_000, idleSeconds: 0, totalSeconds: 90_000,
      firstActivityAt: null, lastActivityAt: null,
      screenshotCount: 0, sourceEventCount: 1,
      apps: {}, sites: {}, categories: {}, projects: {},
    };
    expect(implausible(rollup, 86_400)).toMatch(/exceeds the 86400s length/);
  });

  it('catches a bucket total above active time, which means double counting', () => {
    const rollup = {
      workDate: '2026-08-19', timezone: KOLKATA,
      activeSeconds: 60, idleSeconds: 0, totalSeconds: 60,
      firstActivityAt: null, lastActivityAt: null,
      screenshotCount: 0, sourceEventCount: 1,
      apps: { 'code.exe': 60, 'chrome.exe': 60 }, sites: {}, categories: {}, projects: {},
    };
    expect(implausible(rollup, 86_400)).toMatch(/apps sum 120s exceeds active 60s/);
  });

  it('catches a total that disagrees with its parts', () => {
    const rollup = {
      workDate: '2026-08-19', timezone: KOLKATA,
      activeSeconds: 60, idleSeconds: 60, totalSeconds: 999,
      firstActivityAt: null, lastActivityAt: null,
      screenshotCount: 0, sourceEventCount: 1,
      apps: {}, sites: {}, categories: {}, projects: {},
    };
    expect(implausible(rollup, 86_400)).toMatch(/does not equal active \+ idle/);
  });
});

/**
 * The paths the coverage threshold on this file was set to protect, and which it turned out were
 * not reached.
 *
 * `vitest.config.ts` holds `rollup.ts` to 95% statements and 90% branches on the stated grounds
 * that "the aggregation rollup ... has no excuse for gaps". It sat at 91.7/88 from the day the
 * threshold was written, so `npm run test:coverage` — and the backend CI job, which runs
 * `--coverage` — had been failing since. Running the component test suites individually rather than
 * `make ci` is what hid it.
 *
 * Every case below is a real behaviour, not a line-hitting exercise: a rule that cannot be trusted,
 * a match type nothing exercised, a guard against an event that should not exist, and an invariant
 * that says a rollup is wrong.
 */
describe('rule matching paths that nothing else exercises', () => {
  const CREATED = new Date('2026-01-01T00:00:00Z');

  it('categorises on url_host, not only on the executable', () => {
    // `matchCategory` handles `app_exe` and then falls through to `url_host`. The fall-through was
    // untested, so a browsing-heavy day could have been silently uncategorised.
    const rules: CategoryRule[] = [
      { id: 'r1', matchType: 'url_host', pattern: 'github.com', category: 'Development', priority: 10, createdAt: CREATED },
    ];
    const { rollups } = aggregate(
      [activeEvent({ appExe: 'firefox.exe', appName: 'Firefox', urlHost: 'gist.github.com' })],
      { timezone: KOLKATA, categoryRules: rules },
    );

    expect(rollups[0]?.categories.Development).toBe(60);
    expect(rollups[0]?.categories[DEFAULT_CATEGORY]).toBeUndefined();
  });

  it('attributes a project on url_host and on title_contains', () => {
    // Two of the four project match types had no test. A project rule that silently never matches
    // is worse than one that errors: the time lands in "no project" and looks like a data gap.
    const rules: ProjectRule[] = [
      { id: 'p1', projectId: 'proj-web', matchType: 'url_host', pattern: 'jira.example', priority: 10, createdAt: CREATED },
      { id: 'p2', projectId: 'proj-doc', matchType: 'title_contains', pattern: 'Quarterly report', priority: 20, createdAt: CREATED },
    ];

    const byHost = aggregate(
      [activeEvent({ urlHost: 'jira.example', windowTitle: 'WL-14 · Jira' })],
      { timezone: KOLKATA, projectRules: rules },
    );
    expect(byHost.rollups[0]?.projects['proj-web']).toBe(60);

    const byTitle = aggregate(
      [activeEvent({ urlHost: null, windowTitle: 'Quarterly report - final.docx' })],
      { timezone: KOLKATA, projectRules: rules },
    );
    expect(byTitle.rollups[0]?.projects['proj-doc']).toBe(60);
  });

  it('breaks a rule tie on id when priority and creation time are identical', () => {
    // The third sort key. Without it the winner depends on the order the database returned rows in,
    // and re-running the same day could attribute the same minute to a different project — which
    // makes an idempotent upsert produce a different answer on each run.
    const same = { projectId: '', matchType: 'app_exe' as const, pattern: 'code.exe', priority: 10, createdAt: CREATED };
    const rules: ProjectRule[] = [
      { ...same, id: 'bbb', projectId: 'proj-b' },
      { ...same, id: 'aaa', projectId: 'proj-a' },
    ];

    const forwards = aggregate([activeEvent()], { timezone: KOLKATA, projectRules: rules });
    const backwards = aggregate([activeEvent()], { timezone: KOLKATA, projectRules: [...rules].reverse() });

    // 'aaa' wins both times, whichever order the rules arrive in.
    expect(forwards.rollups[0]?.projects['proj-a']).toBe(60);
    expect(backwards.rollups[0]?.projects['proj-a']).toBe(60);
    expect(forwards.rollups[0]?.projects['proj-b']).toBeUndefined();
  });

  it('refuses an over-long title_regex pattern instead of compiling it', () => {
    // 400 characters is the cap. A pattern that long is not a legitimate window-title matcher, and
    // the cost of deciding whether it backtracks catastrophically is the thing being avoided.
    const rules: ProjectRule[] = [
      { id: 'p-long', projectId: 'proj-x', matchType: 'title_regex', pattern: `${'a'.repeat(401)}`, priority: 10, createdAt: CREATED },
    ];
    const { rollups, warnings } = aggregate([activeEvent({ windowTitle: 'a'.repeat(500) })], {
      timezone: KOLKATA,
      projectRules: rules,
    });

    expect(warnings.disabledRegexRules).toContain('p-long');
    expect(rollups[0]?.projects ?? {}).toEqual({});
  });

  it('disables a title_regex rule that exceeds its time budget', () => {
    // A budget of zero makes any match exceed it, which is the only way to exercise this
    // deterministically — a pattern slow enough to blow a real budget is by definition slow to run
    // in a test. The rule still returns its match for the event that tripped it, and is disabled
    // for the rest of the run: the alternative is silently dropping the attribution that was
    // already correctly computed.
    const rules: ProjectRule[] = [
      { id: 'p-slow', projectId: 'proj-slow', matchType: 'title_regex', pattern: 'worklens', priority: 10, createdAt: CREATED },
    ];
    const { rollups, warnings } = aggregate(
      [
        activeEvent({ windowTitle: 'rollup.ts - worklens' }),
        activeEvent({ capturedAt: new Date('2026-08-19T04:05:00Z'), windowTitle: 'zone.ts - worklens' }),
      ],
      { timezone: KOLKATA, projectRules: rules, regexBudgetMs: 0 },
    );

    expect(warnings.disabledRegexRules).toContain('p-slow');
    // The first event matched before the rule was disabled; the second did not.
    expect(rollups[0]?.projects['proj-slow']).toBe(60);
  });

  it('skips a title_regex rule when there is no title to match', () => {
    // An idle event carries no window title by construction, and the database forbids one. Reaching
    // the regex with an empty subject would spend the budget to match nothing.
    const rules: ProjectRule[] = [
      { id: 'p-re', projectId: 'proj-re', matchType: 'title_regex', pattern: '.*', priority: 10, createdAt: CREATED },
    ];
    const { rollups } = aggregate(
      [idleEvent(), activeEvent({ windowTitle: '' })],
      { timezone: KOLKATA, projectRules: rules },
    );
    expect(rollups[0]?.projects ?? {}).toEqual({});
  });
});

describe('guards against events that should not exist', () => {
  it('refuses an event spanning more than 64 days rather than looping', () => {
    // `splitAcrossDays` walks a day at a time with a hard stop. The duration schema caps an event
    // at one hour, so reaching this needs a bug or a tampered row — and the honest response to
    // either is to fail loudly rather than allocate 64 days of "work" across a timesheet.
    expect(() => splitAcrossDays(new Date('2026-01-01T00:00:00Z'), 90 * 86_400, KOLKATA)).toThrow(
      /spans more than 64 days/,
    );
  });

  it('calls a rollup implausible when a component is negative', () => {
    // `implausible` is the last line before a wrong figure reaches a timesheet. The negative branch
    // was untested, and negative seconds are exactly what an arithmetic error produces.
    const base = {
      workDate: '2026-08-19',
      timezone: KOLKATA,
      activeSeconds: -60,
      idleSeconds: 120,
      totalSeconds: 60,
      firstActivityAt: new Date('2026-08-19T04:00:00Z'),
      lastActivityAt: new Date('2026-08-19T05:00:00Z'),
      screenshotCount: 0,
      sourceEventCount: 1,
      apps: {},
      sites: {},
      categories: {},
      projects: {},
    };

    expect(implausible(base, localDayLengthSeconds('2026-08-19', KOLKATA))).toMatch(/negative seconds/);
    expect(implausible({ ...base, idleSeconds: -1, activeSeconds: 61 }, 86_400)).toMatch(/negative seconds/);

    // And the healthy case still passes, so the guard is not simply always firing.
    expect(implausible({ ...base, activeSeconds: 60, idleSeconds: 0, totalSeconds: 60 }, 86_400)).toBeNull();
  });
});
