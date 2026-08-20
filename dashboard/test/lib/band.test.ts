/**
 * Tests for the day-band geometry.
 *
 * The premise of every test here: this is the one part of the dashboard whose bugs are *invisible*.
 * A wrong total is arguable, a crash is obvious, but a day drawn in the wrong place looks exactly
 * like a day drawn in the right place. So the assertions are on positions, in minutes, against zones
 * chosen for the ways they break naive code: a half-hour offset, a negative offset, a zone that
 * observes DST, and a zone that does not.
 */

import { describe, expect, it } from 'vitest';

import { MINUTES_PER_DAY, buildSpans, minutesFromMidnight, percentOfDay } from '@/lib/band';

describe('minutesFromMidnight', () => {
  it('measures the employee’s wall clock, not the machine’s', () => {
    // 09:00 in Kolkata. The whole product depends on this being 540 for an Indian employee no
    // matter where the manager reading it happens to be sitting.
    const nineAmKolkata = '2026-08-20T03:30:00.000Z';
    expect(minutesFromMidnight(nineAmKolkata, 'Asia/Kolkata')).toBe(9 * 60);

    // The same instant, read in the zones a reader might be in. Different numbers from the same
    // input is the point: if this function ever returned the viewer's offset, this test would show
    // every zone agreeing.
    expect(minutesFromMidnight(nineAmKolkata, 'UTC')).toBe(3 * 60 + 30);
    expect(minutesFromMidnight(nineAmKolkata, 'Australia/Melbourne')).toBe(13 * 60 + 30);
    expect(minutesFromMidnight(nineAmKolkata, 'America/New_York')).toBe(23 * 60 + 30);
  });

  it('handles a half-hour and a three-quarter-hour zone', () => {
    const noonUtc = '2026-08-20T12:00:00.000Z';
    expect(minutesFromMidnight(noonUtc, 'Asia/Kolkata')).toBe(17 * 60 + 30); // +05:30
    expect(minutesFromMidnight(noonUtc, 'Asia/Kathmandu')).toBe(17 * 60 + 45); // +05:45
    expect(minutesFromMidnight(noonUtc, 'Australia/Eucla')).toBe(20 * 60 + 45); // +08:45
  });

  it('puts local midnight at 0, not at 1440', () => {
    // If an ICU build reports midnight as hour "24", an unguarded conversion positions the mark one
    // full day off the left edge — at the far right of the axis, looking like an 11:59pm finish.
    expect(minutesFromMidnight('2026-08-19T18:30:00.000Z', 'Asia/Kolkata')).toBe(0);
    expect(minutesFromMidnight('2026-08-20T00:00:00.000Z', 'UTC')).toBe(0);
  });

  it('follows a DST transition rather than a fixed offset', () => {
    // Melbourne leaves DST at 2026-04-04T16:00Z, where 02:00 +11:00 becomes 02:00 +10:00. Either
    // side of it the same wall clock corresponds to a different instant, which is exactly what code
    // holding a cached offset gets wrong.
    const beforeDst = '2026-04-04T12:00:00.000Z'; // 23:00 +11:00
    const afterDst = '2026-04-05T12:00:00.000Z'; //  22:00 +10:00
    expect(minutesFromMidnight(beforeDst, 'Australia/Melbourne')).toBe(23 * 60);
    expect(minutesFromMidnight(afterDst, 'Australia/Melbourne')).toBe(22 * 60);

    // India does not observe DST, so the same pair of instants keeps a constant offset. This is the
    // control: it fails if the conversion ever starts applying a transition to the wrong zone.
    expect(minutesFromMidnight(beforeDst, 'Asia/Kolkata')).toBe(17 * 60 + 30);
    expect(minutesFromMidnight(afterDst, 'Asia/Kolkata')).toBe(17 * 60 + 30);
  });

  it('maps both halves of a repeated hour onto the same position', () => {
    // The hour 02:00–03:00 happens twice in Melbourne on 5 April 2026. These are two distinct
    // instants an hour apart, and both are legitimately 02:00 local — so the axis position is
    // genuinely ambiguous and the band draws them in the same place.
    //
    // Asserted rather than left implicit because the tempting "fix" is to disambiguate, and there is
    // no correct disambiguation: an employee working through the changeover really did see 02:00 on
    // their clock twice. The day is 25 hours long and the 24-hour axis cannot say otherwise. The
    // totals are what carry that hour, which is why `formatDuration` and not the band is the thing a
    // payroll figure comes from.
    const firstTwoAm = '2026-04-04T15:00:00.000Z'; // 02:00 +11:00
    const secondTwoAm = '2026-04-04T16:00:00.000Z'; // 02:00 +10:00
    expect(minutesFromMidnight(firstTwoAm, 'Australia/Melbourne')).toBe(120);
    expect(minutesFromMidnight(secondTwoAm, 'Australia/Melbourne')).toBe(120);

    // The span between them therefore has no extent on the axis. It must draw as a tick, not as the
    // rest of the day — see the single-event-day test below for what the alternative looked like.
    const { spans } = buildSpans({
      timezone: 'Australia/Melbourne',
      activeSeconds: 3600,
      idleSeconds: 0,
      segments: [{ startedAt: firstTwoAm, endedAt: secondTwoAm, idle: false }],
    });
    expect(spans).toEqual([{ fromMinutes: 120, toMinutes: 120, idle: false }]);
  });

  it('returns null, not midnight, for an unusable input', () => {
    // Null draws nothing. Zero would draw a mark at midnight that is indistinguishable from a real
    // one — the failure mode this whole file exists to avoid.
    expect(minutesFromMidnight('not a timestamp', 'UTC')).toBeNull();
    expect(minutesFromMidnight('', 'UTC')).toBeNull();
    expect(minutesFromMidnight('2026-02-30T00:00:00.000Z', 'UTC')).not.toBeNull(); // V8 rolls this
  });

  it('returns null for an invalid IANA zone instead of throwing', () => {
    // `timezone` arrives from the organisation or employee record, which a deployer populates. Before
    // this was extracted from the component, a typo'd zone threw a RangeError *inside a render*, so
    // one bad row took out every page that draws a band. Degrading to "no mark" is the correct
    // outcome: with no usable zone there is no right position for the mark.
    expect(minutesFromMidnight('2026-08-20T12:00:00.000Z', 'Asia/Calcutta_typo')).toBeNull();
    expect(minutesFromMidnight('2026-08-20T12:00:00.000Z', '')).toBeNull();
    expect(minutesFromMidnight('2026-08-20T12:00:00.000Z', 'Mars/Olympus_Mons')).toBeNull();
  });
});

describe('percentOfDay', () => {
  it('maps the axis onto 0–100%', () => {
    expect(percentOfDay(0)).toBe('0.0000%');
    expect(percentOfDay(MINUTES_PER_DAY)).toBe('100.0000%');
    expect(percentOfDay(12 * 60)).toBe('50.0000%');
  });

  it('keeps enough precision that a short span is still visible', () => {
    // A one-minute span is 0.0694% of a day. Rounded to two decimals it becomes 0.07%, and to one it
    // rounds to 0.1% — a 44% overstatement of a mark a manager might be counting.
    expect(percentOfDay(1)).toBe('0.0694%');
  });
});

describe('buildSpans', () => {
  const kolkata = { timezone: 'Asia/Kolkata', activeSeconds: 0, idleSeconds: 0 };

  it('draws recorded segments individually and says so', () => {
    const { spans, resolution } = buildSpans({
      ...kolkata,
      segments: [
        { startedAt: '2026-08-20T03:30:00Z', endedAt: '2026-08-20T06:30:00Z', idle: false }, // 09:00–12:00
        { startedAt: '2026-08-20T07:30:00Z', endedAt: '2026-08-20T08:00:00Z', idle: true }, // 13:00–13:30
      ],
    });

    expect(resolution).toBe('segments');
    expect(spans).toEqual([
      { fromMinutes: 540, toMinutes: 720, idle: false },
      { fromMinutes: 780, toMinutes: 810, idle: true },
    ]);
  });

  it('leaves the gap between segments as paper', () => {
    // The lunch break is the thing this component is for. Two segments must stay two spans; anything
    // that merged them into one 09:00–13:30 block would be inventing 90 minutes of recorded time.
    const { spans } = buildSpans({
      ...kolkata,
      segments: [
        { startedAt: '2026-08-20T03:30:00Z', endedAt: '2026-08-20T06:30:00Z', idle: false },
        { startedAt: '2026-08-20T07:30:00Z', endedAt: '2026-08-20T08:00:00Z', idle: false },
      ],
    });
    expect(spans).toHaveLength(2);
    expect(spans[1]!.fromMinutes - spans[0]!.toMinutes).toBe(60);
  });

  it('clamps a segment running past local midnight to the end of the day', () => {
    // 23:00 → 01:00 next day. Read as local minutes that is 1380 → 60, which drawn literally is a
    // negative-width bar: invisible. The remainder belongs to the next day, and the aggregation
    // splits events at the boundary so it is genuinely there.
    const { spans } = buildSpans({
      ...kolkata,
      segments: [{ startedAt: '2026-08-20T17:30:00Z', endedAt: '2026-08-20T19:30:00Z', idle: false }],
    });
    expect(spans).toEqual([{ fromMinutes: 1380, toMinutes: MINUTES_PER_DAY, idle: false }]);
  });

  it('skips an unparseable segment without discarding its neighbours', () => {
    const { spans, resolution } = buildSpans({
      ...kolkata,
      segments: [
        { startedAt: 'rubbish', endedAt: '2026-08-20T06:30:00Z', idle: false },
        { startedAt: '2026-08-20T03:30:00Z', endedAt: '2026-08-20T06:30:00Z', idle: false },
      ],
    });
    expect(resolution).toBe('segments');
    expect(spans).toEqual([{ fromMinutes: 540, toMinutes: 720, idle: false }]);
  });

  it('falls back to totals when every segment is unusable', () => {
    // Not 'segments' with an empty array: the caller labels the band from `resolution`, and claiming
    // segment-level precision while showing a totals-derived shape would be a lie about the data.
    const { spans, resolution } = buildSpans({
      timezone: 'Asia/Kolkata',
      activeSeconds: 3600,
      idleSeconds: 0,
      firstActivityAt: '2026-08-20T03:30:00Z',
      lastActivityAt: '2026-08-20T04:30:00Z',
      segments: [{ startedAt: 'rubbish', endedAt: 'also rubbish', idle: false }],
    });
    expect(resolution).toBe('totals');
    expect(spans).toEqual([{ fromMinutes: 540, toMinutes: 600, idle: false }]);
  });

  it('proportions a totals-only day by the active/idle split', () => {
    // 09:00–17:00 is 480 minutes; 6h active of 8h recorded is three quarters of it.
    const { spans, resolution } = buildSpans({
      timezone: 'Asia/Kolkata',
      activeSeconds: 6 * 3600,
      idleSeconds: 2 * 3600,
      firstActivityAt: '2026-08-20T03:30:00Z',
      lastActivityAt: '2026-08-20T11:30:00Z',
    });

    expect(resolution).toBe('totals');
    expect(spans).toEqual([
      { fromMinutes: 540, toMinutes: 900, idle: false },
      { fromMinutes: 900, toMinutes: 1020, idle: true },
    ]);
  });

  it('omits the idle span entirely when there was no idle time', () => {
    const { spans } = buildSpans({
      timezone: 'UTC',
      activeSeconds: 3600,
      idleSeconds: 0,
      firstActivityAt: '2026-08-20T09:00:00Z',
      lastActivityAt: '2026-08-20T10:00:00Z',
    });
    expect(spans).toEqual([{ fromMinutes: 540, toMinutes: 600, idle: false }]);
  });

  it('reports empty rather than drawing a guess', () => {
    const base = { timezone: 'UTC', activeSeconds: 0, idleSeconds: 0 };

    // No activity at all.
    expect(buildSpans(base)).toEqual({ spans: [], resolution: 'empty' });

    // Timestamps but no recorded seconds: a day the agent reported and had nothing to show for.
    expect(
      buildSpans({ ...base, firstActivityAt: '2026-08-20T09:00:00Z', lastActivityAt: '2026-08-20T17:00:00Z' }),
    ).toEqual({ spans: [], resolution: 'empty' });

    // Seconds but a missing bound — nowhere to put them.
    expect(
      buildSpans({ ...base, activeSeconds: 3600, firstActivityAt: '2026-08-20T09:00:00Z', lastActivityAt: null }),
    ).toEqual({ spans: [], resolution: 'empty' });

    // Seconds and bounds, but an unusable zone.
    expect(
      buildSpans({
        timezone: 'Mars/Olympus_Mons',
        activeSeconds: 3600,
        idleSeconds: 0,
        firstActivityAt: '2026-08-20T09:00:00Z',
        lastActivityAt: '2026-08-20T10:00:00Z',
      }),
    ).toEqual({ spans: [], resolution: 'empty' });
  });

  it('extends a totals day to midnight when it ends after local midnight', () => {
    // 22:00 start, 01:00 finish. Without the clamp the width is negative and nothing is drawn at all,
    // which reads as "no work recorded" on a night shift that was in fact worked.
    const { spans } = buildSpans({
      timezone: 'UTC',
      activeSeconds: 3 * 3600,
      idleSeconds: 0,
      firstActivityAt: '2026-08-20T22:00:00Z',
      lastActivityAt: '2026-08-21T01:00:00Z',
    });
    expect(spans).toEqual([{ fromMinutes: 1320, toMinutes: MINUTES_PER_DAY, idle: false }]);
  });

  it('draws a single-event day as a tick, not as the rest of the day', () => {
    // A regression test for a real defect. On a day with one activity event, first and last activity
    // are the same instant, so the span has zero extent. The original code tested `to <= from` and
    // clamped that to the end of the day: five minutes of recorded work at 09:00 drew 900 minutes of
    // solid active ink running to midnight. Nothing about the band said otherwise, and the totals
    // column beside it said "5m" — so the picture and the figure disagreed, and the picture is what
    // gets looked at.
    const { spans } = buildSpans({
      timezone: 'UTC',
      activeSeconds: 300,
      idleSeconds: 0,
      firstActivityAt: '2026-08-20T09:00:00Z',
      lastActivityAt: '2026-08-20T09:00:00Z',
    });
    expect(spans).toEqual([{ fromMinutes: 540, toMinutes: 540, idle: false }]);
  });

  it('still clamps a genuine midnight wrap to the end of the day', () => {
    // The other half of the same condition, kept honest: `to < from` really is a wrap and really
    // should reach midnight. Fixing the zero-width case must not break the night shift.
    const { spans } = buildSpans({
      timezone: 'UTC',
      activeSeconds: 2 * 3600,
      idleSeconds: 0,
      segments: [{ startedAt: '2026-08-20T23:00:00Z', endedAt: '2026-08-21T01:00:00Z', idle: false }],
    });
    expect(spans).toEqual([{ fromMinutes: 1380, toMinutes: MINUTES_PER_DAY, idle: false }]);
  });

  it('never draws outside the axis', () => {
    // A blanket invariant: whatever the input, every span stays inside 0–1440 and runs forwards.
    // A span outside the axis is a CSS offset over 100%, which overflows the row rather than erroring.
    const inputs = [
      { timezone: 'Asia/Kolkata', activeSeconds: 8 * 3600, idleSeconds: 3600, firstActivityAt: '2026-08-20T17:30:00Z', lastActivityAt: '2026-08-20T19:00:00Z' },
      { timezone: 'Pacific/Kiritimati', activeSeconds: 3600, idleSeconds: 3600, firstActivityAt: '2026-08-20T09:00:00Z', lastActivityAt: '2026-08-20T23:59:00Z' },
      { timezone: 'Pacific/Niue', activeSeconds: 1, idleSeconds: 0, firstActivityAt: '2026-08-20T00:00:00Z', lastActivityAt: '2026-08-20T00:01:00Z' },
    ];

    for (const input of inputs) {
      for (const span of buildSpans(input).spans) {
        expect(span.fromMinutes).toBeGreaterThanOrEqual(0);
        expect(span.toMinutes).toBeLessThanOrEqual(MINUTES_PER_DAY);
        expect(span.toMinutes).toBeGreaterThanOrEqual(span.fromMinutes);
      }
    }
  });
});
