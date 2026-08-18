package privacy

import (
	"strings"
	"testing"
	"time"
)

// Kolkata is the default deployment timezone. Chosen for these tests over UTC precisely
// because it is offset by a non-whole number of hours (+05:30) — a bug that accidentally
// evaluates work hours in UTC produces a plausible-looking but wrong answer, and a half-hour
// offset makes that visible.
var kolkata = mustLoad("Asia/Kolkata")

func mustLoad(name string) *time.Location {
	loc, err := time.LoadLocation(name)
	if err != nil {
		panic(err)
	}
	return loc
}

// weekdays is Monday–Friday in ISO-8601 numbering, matching monitoring_config.work_days.
var weekdays = []int{1, 2, 3, 4, 5}

func at(t *testing.T, layout string) time.Time {
	t.Helper()
	parsed, err := time.ParseInLocation("2006-01-02 15:04", layout, kolkata)
	if err != nil {
		t.Fatalf("bad test timestamp %q: %v", layout, err)
	}
	return parsed
}

func officeHours() Config {
	return Config{
		CaptureWindowTitles: true,
		CaptureURLs:         true,
		WorkHoursOnly:       true,
		WorkHoursStart:      TimeOfDay(9 * 60),     // 09:00
		WorkHoursEnd:        TimeOfDay(17*60 + 30), // 17:30
		WorkDays:            weekdays,
	}
}

func activeSample(when time.Time) Sample {
	return Sample{
		CapturedAt:  when,
		Duration:    60 * time.Second,
		IsIdle:      false,
		AppName:     "code.exe",
		AppExe:      `C:\Users\asha\AppData\Local\Programs\Microsoft VS Code\code.exe`,
		WindowTitle: "rules.go - worklens - Visual Studio Code",
	}
}

// ---------------------------------------------------------------------------
// The ISO / Go weekday conversion
// ---------------------------------------------------------------------------

func TestIsoWeekday(t *testing.T) {
	// The server stores 1 = Monday … 7 = Sunday; Go uses 0 = Sunday … 6 = Saturday. Mixing
	// them shifts everyone's working week by a day.
	cases := map[time.Weekday]int{
		time.Monday: 1, time.Tuesday: 2, time.Wednesday: 3, time.Thursday: 4,
		time.Friday: 5, time.Saturday: 6, time.Sunday: 7,
	}
	for day, want := range cases {
		if got := isoWeekday(day); got != want {
			t.Errorf("isoWeekday(%s) = %d, want %d", day, got, want)
		}
	}
}

// ---------------------------------------------------------------------------
// Ordinary work-hours window
// ---------------------------------------------------------------------------

func TestWorkHoursSameDay(t *testing.T) {
	f := New(officeHours(), kolkata)

	cases := []struct {
		when  string
		allow bool
		note  string
	}{
		{"2026-08-19 08:59", false, "one minute before the start"},
		{"2026-08-19 09:00", true, "exactly at the start — inclusive"},
		{"2026-08-19 13:00", true, "the middle of the day"},
		{"2026-08-19 17:29", true, "one minute before the end"},
		{"2026-08-19 17:30", false, "exactly at the end — exclusive, or a 17:30 finish is monitored"},
		{"2026-08-19 23:00", false, "late evening"},
		{"2026-08-19 03:00", false, "the small hours"},
	}

	for _, tc := range cases {
		d := f.Decide(activeSample(at(t, tc.when)))
		if d.Allow != tc.allow {
			t.Errorf("%s (%s): Allow = %v, want %v (reason %q)", tc.when, tc.note, d.Allow, tc.allow, d.Reason)
		}
	}
}

func TestNonWorkingDays(t *testing.T) {
	f := New(officeHours(), kolkata)

	// 2026-08-22 is a Saturday, 2026-08-23 a Sunday, 2026-08-24 a Monday.
	for _, day := range []string{"2026-08-22 11:00", "2026-08-23 11:00"} {
		d := f.Decide(activeSample(at(t, day)))
		if d.Allow {
			t.Errorf("%s: weekend sample was allowed", day)
		}
		if d.Reason != ReasonNonWorkingDay {
			t.Errorf("%s: reason = %q, want %q", day, d.Reason, ReasonNonWorkingDay)
		}
	}

	if d := f.Decide(activeSample(at(t, "2026-08-24 11:00"))); !d.Allow {
		t.Errorf("Monday 11:00 was rejected: %s (%s)", d.Reason, d.Detail)
	}
}

func TestWorkHoursOnlyDisabledIgnoresTheWindow(t *testing.T) {
	// An all-day policy is expressed by turning the restriction off, not by setting a
	// 00:00-00:00 window — which is why the server rejects start == end.
	config := officeHours()
	config.WorkHoursOnly = false
	f := New(config, kolkata)

	for _, when := range []string{"2026-08-23 03:00", "2026-08-19 23:45"} {
		if d := f.Decide(activeSample(at(t, when))); !d.Allow {
			t.Errorf("%s: rejected despite WorkHoursOnly=false: %s", when, d.Reason)
		}
	}
}

func TestEmptyWorkDaysFailsClosed(t *testing.T) {
	// The server's CHECK requires 1-7 entries, so an empty list means a bug. Treating empty as
	// "every day" would turn a configuration mistake into unrestricted monitoring.
	config := officeHours()
	config.WorkDays = nil
	f := New(config, kolkata)

	if d := f.Decide(activeSample(at(t, "2026-08-19 11:00"))); d.Allow {
		t.Error("an empty WorkDays list allowed capture; it must fail closed")
	}
}

// ---------------------------------------------------------------------------
// The overnight window — the case most likely to be wrong
// ---------------------------------------------------------------------------

func TestWorkHoursSpanningMidnight(t *testing.T) {
	config := officeHours()
	config.WorkHoursStart = TimeOfDay(22 * 60) // 22:00
	config.WorkHoursEnd = TimeOfDay(6 * 60)    // 06:00
	f := New(config, kolkata)

	cases := []struct {
		when  string
		allow bool
		note  string
	}{
		// Wednesday 2026-08-19 is a working day.
		{"2026-08-19 22:00", true, "shift start on a working day"},
		{"2026-08-19 23:59", true, "before midnight on a working day"},
		{"2026-08-20 00:30", true, "after midnight — belongs to Wednesday's shift"},
		{"2026-08-20 05:59", true, "one minute before the shift ends"},
		{"2026-08-20 06:00", false, "shift end is exclusive"},
		{"2026-08-20 12:00", false, "the middle of the day is outside an overnight shift"},
		{"2026-08-20 21:59", false, "one minute before the next shift"},

		// Saturday 2026-08-22 00:30 is the tail of Friday's shift — Friday is a working day.
		{"2026-08-22 00:30", true, "Saturday morning is the tail of Friday's shift"},
		// Saturday 22:00 starts a shift on a non-working day.
		{"2026-08-22 22:00", false, "no shift starts on Saturday"},
		// Sunday 00:30 would be the tail of Saturday's shift, and Saturday is not a working day.
		{"2026-08-23 00:30", false, "Sunday morning is the tail of a shift that never started"},
		// Monday 00:30 is the tail of Sunday — not a working day.
		{"2026-08-24 00:30", false, "Monday morning is the tail of Sunday, not a working day"},
		// Monday 22:00 starts Monday's shift.
		{"2026-08-24 22:00", true, "Monday's shift starts"},
	}

	for _, tc := range cases {
		d := f.Decide(activeSample(at(t, tc.when)))
		if d.Allow != tc.allow {
			t.Errorf("%s (%s): Allow = %v, want %v (reason %q, detail %q)",
				tc.when, tc.note, d.Allow, tc.allow, d.Reason, d.Detail)
		}
	}
}

// ---------------------------------------------------------------------------
// Timezone handling
// ---------------------------------------------------------------------------

func TestWorkHoursAreEvaluatedInTheEmployeeTimezone(t *testing.T) {
	f := New(officeHours(), kolkata)

	// 05:00 UTC is 10:30 in Kolkata — inside the window. An implementation that evaluated in
	// UTC would reject this, and would look correct to anyone testing in a UTC-ish zone.
	utcMorning := time.Date(2026, 8, 19, 5, 0, 0, 0, time.UTC)
	if d := f.Decide(activeSample(utcMorning)); !d.Allow {
		t.Errorf("05:00 UTC (10:30 IST) was rejected: %s (%s)", d.Reason, d.Detail)
	}

	// 20:00 UTC is 01:30 the next day in Kolkata — outside the window, and on the following
	// calendar day.
	utcEvening := time.Date(2026, 8, 19, 20, 0, 0, 0, time.UTC)
	if d := f.Decide(activeSample(utcEvening)); d.Allow {
		t.Error("20:00 UTC (01:30 IST next day) was allowed")
	}
}

func TestNilLocationDefaultsToUTCNotMachineLocal(t *testing.T) {
	// A laptop's timezone is user-changeable; the work-hours window is employer policy. It
	// must not move because somebody changed a system setting.
	f := New(officeHours(), nil)
	if f.Location() != time.UTC {
		t.Errorf("nil location resolved to %v, want UTC", f.Location())
	}
}

func TestDaylightSavingTransition(t *testing.T) {
	// Kolkata has no DST, so a zone that does is needed to exercise this. In Melbourne, DST
	// began 2026-10-04 at 02:00 local — 02:00-03:00 does not exist that day.
	melbourne := mustLoad("Australia/Melbourne")
	config := officeHours()
	config.WorkHoursStart = TimeOfDay(1 * 60)
	config.WorkHoursEnd = TimeOfDay(9 * 60)
	config.WorkDays = []int{1, 2, 3, 4, 5, 6, 7}
	f := New(config, melbourne)

	// 01:30 exists and is inside the window.
	before := time.Date(2026, 10, 4, 1, 30, 0, 0, melbourne)
	if d := f.Decide(activeSample(before)); !d.Allow {
		t.Errorf("01:30 on the DST transition day was rejected: %s (%s)", d.Reason, d.Detail)
	}

	// 03:30 exists (the clock jumped 02:00 → 03:00) and is still inside the window. The point
	// is that the filter neither panics nor silently rejects a whole morning.
	after := time.Date(2026, 10, 4, 3, 30, 0, 0, melbourne)
	if d := f.Decide(activeSample(after)); !d.Allow {
		t.Errorf("03:30 after the DST jump was rejected: %s (%s)", d.Reason, d.Detail)
	}
}

// ---------------------------------------------------------------------------
// Application exclusions
// ---------------------------------------------------------------------------

func TestExcludedApps(t *testing.T) {
	config := officeHours()
	config.ExcludedApps = []string{"KeePass", "1password", `\Banking\`}
	f := New(config, kolkata)

	when := at(t, "2026-08-19 11:00")

	cases := []struct {
		name    string
		sample  Sample
		exclude bool
	}{
		{
			name:    "exact executable, different case",
			sample:  Sample{CapturedAt: when, AppName: "keepass.exe", AppExe: `C:\Program Files\KeePass\keepass.exe`},
			exclude: true,
		},
		{
			name:    "matches on the full path when the executable name is generic",
			sample:  Sample{CapturedAt: when, AppName: "electron.exe", AppExe: `C:\Apps\Banking\electron.exe`},
			exclude: true,
		},
		{
			name:    "substring of the app name",
			sample:  Sample{CapturedAt: when, AppName: "1Password.exe", AppExe: `C:\Program Files\1Password\1Password.exe`},
			exclude: true,
		},
		{
			name:    "an unrelated application is kept",
			sample:  activeSample(when),
			exclude: false,
		},
	}

	for _, tc := range cases {
		d := f.Decide(tc.sample)
		if tc.exclude && d.Allow {
			t.Errorf("%s: sample was allowed but should have been excluded", tc.name)
		}
		if !tc.exclude && !d.Allow {
			t.Errorf("%s: sample was excluded but should have been allowed (%s %s)", tc.name, d.Reason, d.Detail)
		}
		if tc.exclude && d.Reason != ReasonExcludedApp {
			t.Errorf("%s: reason = %q, want %q", tc.name, d.Reason, ReasonExcludedApp)
		}
	}
}

func TestExclusionDetailDoesNotLeakContent(t *testing.T) {
	// The Detail is shown by `agentctl doctor`. It must name the RULE, never the title or host
	// that matched — that content is exactly what the exclusion existed to suppress.
	config := officeHours()
	config.ExcludedURLPatterns = []string{"*bank*"}
	f := New(config, kolkata)

	d := f.Decide(Sample{
		CapturedAt:  at(t, "2026-08-19 11:00"),
		AppName:     "chrome.exe",
		WindowTitle: "ANZ Internet Banking — Account 123456 — Google Chrome",
		URLHost:     "anz.com.au",
	})

	if d.Allow {
		t.Fatal("excluded sample was allowed")
	}
	if strings.Contains(d.Detail, "123456") || strings.Contains(d.Detail, "anz.com.au") {
		t.Errorf("Detail leaked suppressed content: %q", d.Detail)
	}
	if d.Detail != "*bank*" {
		t.Errorf("Detail = %q, want the matching pattern", d.Detail)
	}
}

// ---------------------------------------------------------------------------
// URL exclusions
// ---------------------------------------------------------------------------

func TestExcludedURLPatterns(t *testing.T) {
	config := officeHours()
	config.ExcludedURLPatterns = []string{"*.anz.com.au", "*bank*", "health.gov.au", "mail.google.com"}
	f := New(config, kolkata)

	when := at(t, "2026-08-19 11:00")

	cases := []struct {
		name    string
		host    string
		title   string
		exclude bool
	}{
		{"wildcard subdomain", "www.anz.com.au", "Accounts", true},
		{"bare domain matches a *. pattern", "anz.com.au", "Accounts", true},
		{"substring pattern against the host", "mybank.example", "Home", true},
		{
			name:    "title reveals the site even with no host derived",
			host:    "",
			title:   "Internet Banking - Google Chrome",
			exclude: true,
		},
		{"exact host", "health.gov.au", "Medicare", true},
		{"unrelated site is kept", "github.com", "worklens - Pull requests", false},
		// A lookalike domain must NOT be excluded by "*.anz.com.au". The exclusion exists to
		// keep the employee's real bank private; a phishing host that merely contains the
		// string is a different site, and silently suppressing it would hide activity the
		// employer legitimately sees while protecting nothing.
		{"a lookalike domain is not excluded", "anz.com.au.evil.example", "x", false},
	}

	for _, tc := range cases {
		d := f.Decide(Sample{
			CapturedAt: when, AppName: "chrome.exe",
			AppExe:      `C:\Program Files\Google\Chrome\Application\chrome.exe`,
			WindowTitle: tc.title, URLHost: tc.host,
		})
		if tc.exclude && d.Allow {
			t.Errorf("%s (host=%q title=%q): allowed but should be excluded", tc.name, tc.host, tc.title)
		}
		if !tc.exclude && !d.Allow {
			t.Errorf("%s (host=%q title=%q): excluded but should be allowed (%s %s)",
				tc.name, tc.host, tc.title, d.Reason, d.Detail)
		}
	}
}

func TestNoExclusionsMeansNoExclusion(t *testing.T) {
	f := New(officeHours(), kolkata)
	d := f.Decide(Sample{
		CapturedAt: at(t, "2026-08-19 11:00"),
		AppName:    "chrome.exe", WindowTitle: "Anything at all", URLHost: "example.com",
	})
	if !d.Allow {
		t.Errorf("sample rejected with no exclusions configured: %s %s", d.Reason, d.Detail)
	}
}

func TestBlankPatternsAreIgnored(t *testing.T) {
	// An empty string as a substring matches everything, which would silently suppress all
	// capture. A stray blank entry in a config array must be inert.
	config := officeHours()
	config.ExcludedApps = []string{"", "   "}
	config.ExcludedURLPatterns = []string{"", "  "}
	f := New(config, kolkata)

	if d := f.Decide(activeSample(at(t, "2026-08-19 11:00"))); !d.Allow {
		t.Errorf("blank exclusion patterns suppressed capture: %s %q", d.Reason, d.Detail)
	}
}

// ---------------------------------------------------------------------------
// Scrubbing
// ---------------------------------------------------------------------------

func TestIdleSampleLosesAllAttribution(t *testing.T) {
	// The promise to employees: idle minutes cannot reveal what was on screen. The server's
	// activity_events_idle_no_attribution_chk rejects the whole batch if this is missed, so
	// failing here loses every good event in the batch too.
	f := New(officeHours(), kolkata)

	d := f.Decide(Sample{
		CapturedAt:  at(t, "2026-08-19 11:00"),
		Duration:    5 * time.Minute,
		IsIdle:      true,
		AppName:     "chrome.exe",
		AppExe:      `C:\chrome.exe`,
		WindowTitle: "Payslip - MYOB",
		URLHost:     "myob.com",
		URLTitle:    "Payslip",
	})

	if !d.Allow {
		t.Fatalf("idle sample was rejected outright: %s", d.Reason)
	}
	s := d.Sample
	if s.AppName != "" || s.AppExe != "" || s.WindowTitle != "" || s.URLHost != "" || s.URLTitle != "" {
		t.Errorf("idle sample retained attribution: %+v", s)
	}
	if !s.IsIdle || s.Duration != 5*time.Minute {
		t.Errorf("scrubbing damaged the idle sample's own fields: %+v", s)
	}
}

func TestCaptureTogglesScrubFields(t *testing.T) {
	when := at(t, "2026-08-19 11:00")

	full := Sample{
		CapturedAt: when, AppName: "chrome.exe", AppExe: `C:\chrome.exe`,
		WindowTitle: "Docs - Chrome", URLHost: "docs.google.com", URLTitle: "Docs",
	}

	t.Run("titles disabled", func(t *testing.T) {
		config := officeHours()
		config.CaptureWindowTitles = false
		d := New(config, kolkata).Decide(full)

		if d.Sample.WindowTitle != "" {
			t.Errorf("window title retained with capture disabled: %q", d.Sample.WindowTitle)
		}
		// The application is still recorded: that is what makes a timesheet, and it is a
		// separate setting.
		if d.Sample.AppName != "chrome.exe" {
			t.Errorf("app name was dropped along with the title: %q", d.Sample.AppName)
		}
	})

	t.Run("urls disabled", func(t *testing.T) {
		config := officeHours()
		config.CaptureURLs = false
		d := New(config, kolkata).Decide(full)

		if d.Sample.URLHost != "" || d.Sample.URLTitle != "" {
			t.Errorf("URL fields retained with capture disabled: %+v", d.Sample)
		}
		if d.Sample.WindowTitle == "" {
			t.Error("window title was dropped by the URL toggle")
		}
	})

	t.Run("both disabled — the least-invasive default", func(t *testing.T) {
		config := officeHours()
		config.CaptureWindowTitles = false
		config.CaptureURLs = false
		d := New(config, kolkata).Decide(full)

		if d.Sample.WindowTitle != "" || d.Sample.URLHost != "" || d.Sample.URLTitle != "" {
			t.Errorf("content retained with all capture toggles off: %+v", d.Sample)
		}
		if d.Sample.AppName == "" {
			t.Error("an app name is still needed to produce a timesheet at all")
		}
	})
}

func TestExclusionIsCheckedBeforeScrubbing(t *testing.T) {
	// With titles disabled, an excluded site must STILL be excluded: the exclusion is matched
	// against the raw title, before scrubbing removes it. Otherwise turning titles off would
	// silently disable every title-based exclusion.
	config := officeHours()
	config.CaptureWindowTitles = false
	config.ExcludedURLPatterns = []string{"*banking*"}
	f := New(config, kolkata)

	d := f.Decide(Sample{
		CapturedAt:  at(t, "2026-08-19 11:00"),
		AppName:     "chrome.exe",
		WindowTitle: "Internet Banking - Google Chrome",
	})

	if d.Allow {
		t.Error("an excluded site was allowed because titles were disabled")
	}
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

func TestAllowScreenshot(t *testing.T) {
	f := New(officeHours(), kolkata)

	if d := f.AllowScreenshot(at(t, "2026-08-19 11:00"), false); d.Allow {
		t.Error("a screenshot was allowed with screenshots disabled")
	}
	if d := f.AllowScreenshot(at(t, "2026-08-19 11:00"), true); !d.Allow {
		t.Errorf("an in-hours screenshot was rejected: %s %s", d.Reason, d.Detail)
	}
	if d := f.AllowScreenshot(at(t, "2026-08-19 23:00"), true); d.Allow {
		t.Error("an out-of-hours screenshot was allowed")
	}
	if d := f.AllowScreenshot(at(t, "2026-08-23 11:00"), true); d.Allow {
		t.Error("a Sunday screenshot was allowed")
	}
}

// ---------------------------------------------------------------------------
// Config updates
// ---------------------------------------------------------------------------

func TestUpdateAppliesNewConfig(t *testing.T) {
	f := New(officeHours(), kolkata)
	sample := activeSample(at(t, "2026-08-19 20:00")) // outside 09:00-17:30

	if d := f.Decide(sample); d.Allow {
		t.Fatal("20:00 was allowed under office hours")
	}

	evening := officeHours()
	evening.WorkHoursStart = TimeOfDay(18 * 60)
	evening.WorkHoursEnd = TimeOfDay(22 * 60)
	f.Update(evening, kolkata)

	if d := f.Decide(sample); !d.Allow {
		t.Errorf("20:00 was rejected after moving the window to 18:00-22:00: %s %s", d.Reason, d.Detail)
	}
}

// ---------------------------------------------------------------------------
// Time-of-day helpers
// ---------------------------------------------------------------------------

func TestParseTimeOfDay(t *testing.T) {
	cases := map[string]TimeOfDay{
		"09:00":    TimeOfDay(9 * 60),
		"17:30":    TimeOfDay(17*60 + 30),
		"00:00":    TimeOfDay(0),
		"23:59":    TimeOfDay(23*60 + 59),
		"09:00:00": TimeOfDay(9 * 60), // Postgres renders a `time` with seconds
	}
	for input, want := range cases {
		got, err := ParseTimeOfDay(input)
		if err != nil {
			t.Errorf("ParseTimeOfDay(%q) errored: %v", input, err)
			continue
		}
		if got != want {
			t.Errorf("ParseTimeOfDay(%q) = %d, want %d", input, got, want)
		}
	}

	for _, bad := range []string{"", "9", "24:00", "09:60", "-1:00", "abc", "09:00:00:00"} {
		if _, err := ParseTimeOfDay(bad); err == nil {
			t.Errorf("ParseTimeOfDay(%q) was accepted", bad)
		}
	}
}

func TestTimeOfDayString(t *testing.T) {
	if got := TimeOfDay(9 * 60).String(); got != "09:00" {
		t.Errorf("String() = %q, want 09:00", got)
	}
	if got := TimeOfDay(17*60 + 30).String(); got != "17:30" {
		t.Errorf("String() = %q, want 17:30", got)
	}
}

func TestNewTimeOfDayRejectsOutOfRange(t *testing.T) {
	for _, tc := range [][2]int{{24, 0}, {-1, 0}, {0, 60}, {0, -1}} {
		if _, err := NewTimeOfDay(tc[0], tc[1]); err == nil {
			t.Errorf("NewTimeOfDay(%d, %d) was accepted", tc[0], tc[1])
		}
	}
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

func TestGlobMatch(t *testing.T) {
	cases := []struct {
		pattern, value string
		want           bool
	}{
		{"*.example.com", "www.example.com", true},
		{"*.example.com", "a.b.example.com", true}, // `*` must cross dots, unlike filepath.Match
		{"*.example.com", "example.com", false},    // handled separately by the *. rule
		{"*bank*", "mybanking.example", true},
		{"exact.com", "exact.com", true},
		{"exact.com", "notexact.com", false},
		{"a?c.com", "abc.com", true},
		{"a?c.com", "ac.com", false},
		{"[abc]x.com", "ax.com", true},
		{"[abc]x.com", "dx.com", false},
		{"[!abc]x.com", "dx.com", true},
		{"[a-c]x.com", "bx.com", true},
		{"[a-c]x.com", "dx.com", false},
		{"*", "anything", true},
		{"[unclosed", "x", false}, // a malformed pattern must not crash the capture loop
		{"", "x", false},
		{"*", "", false},
	}

	for _, tc := range cases {
		if got := globMatch(tc.pattern, tc.value); got != tc.want {
			t.Errorf("globMatch(%q, %q) = %v, want %v", tc.pattern, tc.value, got, tc.want)
		}
	}
}

func TestGlobMatchTerminatesOnPathologicalPattern(t *testing.T) {
	// A pattern of many stars against a long value is the classic catastrophic-backtracking
	// shape. The matcher is iterative, so this must return promptly rather than hang the
	// capture goroutine.
	done := make(chan bool, 1)
	go func() {
		done <- globMatch(strings.Repeat("*a", 30), strings.Repeat("a", 200)+"b")
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("globMatch did not terminate on a pathological pattern")
	}
}
