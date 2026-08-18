// Package privacy decides what the agent is allowed to record.
//
// This is the most important package in the agent. Everything else moves data around; this is
// where the product's promises to the people being monitored are actually kept.
//
// # Where it sits, and why that matters
//
// The filter runs between capture and the local SQLite buffer — not between the buffer and
// the uploader. That ordering is the whole point: an excluded application, an excluded URL, or
// a sample taken outside working hours is **never written to disk at all**. There is no window
// in which sensitive data sits locally waiting to be filtered, so no later bug can upload it,
// and nothing is recoverable from the laptop afterwards by anyone.
//
// Putting the filter on the upload path instead would look identical in a code review and be
// substantially worse.
//
// # Two numbering conventions that must not be mixed
//
// The server stores `monitoring_config.work_days` as ISO-8601 weekdays: 1 = Monday through
// 7 = Sunday. Go's `time.Weekday` is 0 = Sunday through 6 = Saturday. Confusing the two
// shifts everybody's working week by a day, which is the kind of bug that looks like
// "monitoring is broken on Sundays" and takes a week to trace. Conversion happens in exactly
// one place: isoWeekday.
//
// # Decisions are explainable
//
// Every rejection carries a Reason. That is not for the logs — a rejected sample is never
// logged with its content — it is so `agentctl doctor` can answer "why is nothing being
// recorded right now?" with "outside working hours (Sat)" instead of silence. An agent that
// silently records nothing is indistinguishable from a broken one.
package privacy

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"
)

// TimeOfDay is minutes since local midnight, matching a Postgres `time` column closely enough
// for a work-hours window while staying trivially comparable.
type TimeOfDay int

// NewTimeOfDay builds a TimeOfDay from an hour and minute.
func NewTimeOfDay(hour, minute int) (TimeOfDay, error) {
	if hour < 0 || hour > 23 || minute < 0 || minute > 59 {
		return 0, fmt.Errorf("privacy: %02d:%02d is not a valid time of day", hour, minute)
	}
	return TimeOfDay(hour*60 + minute), nil
}

// ParseTimeOfDay accepts "HH:MM" or "HH:MM:SS", the shapes Postgres renders a `time` as.
// Seconds are truncated: a work-hours boundary to the second is a precision nobody wants and
// would make the wrapping logic below harder to reason about for no benefit.
func ParseTimeOfDay(value string) (TimeOfDay, error) {
	parts := strings.Split(strings.TrimSpace(value), ":")
	if len(parts) != 2 && len(parts) != 3 {
		return 0, fmt.Errorf("privacy: %q is not HH:MM or HH:MM:SS", value)
	}

	var hour, minute int
	if _, err := fmt.Sscanf(parts[0]+":"+parts[1], "%d:%d", &hour, &minute); err != nil {
		return 0, fmt.Errorf("privacy: %q is not HH:MM or HH:MM:SS: %w", value, err)
	}
	return NewTimeOfDay(hour, minute)
}

func (t TimeOfDay) String() string {
	return fmt.Sprintf("%02d:%02d", int(t)/60, int(t)%60)
}

// timeOfDayAt returns the local time of day for an instant.
func timeOfDayAt(when time.Time) TimeOfDay {
	return TimeOfDay(when.Hour()*60 + when.Minute())
}

// isoWeekday converts Go's Sunday-based weekday to the ISO-8601 Monday-based number the
// server stores. This is the ONLY place the two conventions meet.
func isoWeekday(day time.Weekday) int {
	if day == time.Sunday {
		return 7
	}
	return int(day)
}

// Config is the subset of the organisation's monitoring configuration the filter needs.
//
// It mirrors `monitoring_config` in the schema. Field-for-field rather than embedding the
// whole config so it is obvious, from this struct alone, exactly which settings can suppress
// data — nothing else in the agent gets to make that decision.
type Config struct {
	// CaptureWindowTitles controls whether a window title is recorded at all.
	CaptureWindowTitles bool
	// CaptureURLs controls whether a derived host and page title are recorded.
	CaptureURLs bool

	// WorkHoursOnly restricts capture to the window below. When false the window is ignored
	// entirely — an all-day window is expressed this way rather than as 00:00–00:00, which is
	// why the server rejects start == end.
	WorkHoursOnly  bool
	WorkHoursStart TimeOfDay
	WorkHoursEnd   TimeOfDay
	// WorkDays holds ISO-8601 weekdays: 1 = Monday … 7 = Sunday.
	WorkDays []int

	// ExcludedApps are matched case-insensitively against both the executable's base name and
	// its full path, as substrings. Substring rather than exact match because a deployer
	// writing "banking" should not have to know the executable name.
	ExcludedApps []string
	// ExcludedURLPatterns are glob patterns matched against the derived host AND the raw
	// window title. Both, because a title can name the site even when no host was derived —
	// "Internet Banking - Chrome" reveals what an excluded host was meant to hide.
	ExcludedURLPatterns []string
}

// Sample is the shape the filter operates on. It mirrors the capture package's sample without
// importing it, so privacy has no dependency on the capture machinery and can be tested alone.
type Sample struct {
	CapturedAt  time.Time
	Duration    time.Duration
	IsIdle      bool
	AppName     string
	AppExe      string
	WindowTitle string
	URLHost     string
	URLTitle    string
}

// Reason explains a filter outcome. Stable strings: `agentctl doctor` and the tray tooltip
// show them to a person.
type Reason string

const (
	ReasonAllowed          Reason = "allowed"
	ReasonOutsideWorkHours Reason = "outside working hours"
	ReasonNonWorkingDay    Reason = "not a working day"
	ReasonExcludedApp      Reason = "application is excluded"
	ReasonExcludedURL      Reason = "site is excluded"
)

// Decision is the outcome of filtering one sample.
type Decision struct {
	// Allow is false when nothing at all should be stored for this sample.
	Allow bool
	// Reason is why. Always set, including on success.
	Reason Reason
	// Detail names the matching rule, for `agentctl doctor`. Deliberately does NOT include the
	// window title or host that matched — that content is exactly what was meant to be
	// suppressed, and putting it in a diagnostic would leak it into logs.
	Detail string
	// Sample is the scrubbed sample to store. Only meaningful when Allow is true.
	Sample Sample
}

// Filter applies an organisation's configuration to captured samples.
//
// Safe for concurrent use through Decide; Update swaps the configuration atomically from the
// caller's perspective because the config poller and the sampler run on different goroutines.
type Filter struct {
	config Config
	// location is the employee's timezone. Work hours are local to the person, not to the
	// server: 09:00 means their 09:00.
	location *time.Location
}

// New builds a Filter. A nil location falls back to UTC rather than the machine's local zone,
// because a laptop's timezone is user-changeable and the work-hours window is a policy the
// employer set — it should not move because someone changed a system setting.
func New(config Config, location *time.Location) *Filter {
	if location == nil {
		location = time.UTC
	}
	return &Filter{config: config, location: location}
}

// Update replaces the configuration, for when the poller fetches a new config_version.
func (f *Filter) Update(config Config, location *time.Location) {
	if location == nil {
		location = time.UTC
	}
	f.config = config
	f.location = location
}

// Config returns the configuration in force, for diagnostics.
func (f *Filter) Config() Config { return f.config }

// Location returns the timezone work hours are evaluated in.
func (f *Filter) Location() *time.Location { return f.location }

// Decide filters and scrubs one sample.
//
// The order is deliberate and each step is cheaper than the next:
//
//  1. Work hours and working day — nothing outside them is recorded, whatever it was.
//  2. Excluded application — checked before the title is looked at.
//  3. Excluded URL, against host and raw title.
//  4. Scrubbing: drop what the capture toggles disallow, and strip all attribution from an
//     idle sample.
//
// Step 4 is not optional. The server's `activity_events_idle_no_attribution_chk` rejects an
// idle event carrying an app or a title, so failing to scrub here would not leak data — it
// would reject the entire batch, losing every good event in it too.
func (f *Filter) Decide(sample Sample) Decision {
	if f.config.WorkHoursOnly {
		if ok, reason, detail := f.withinWorkHours(sample.CapturedAt); !ok {
			return Decision{Allow: false, Reason: reason, Detail: detail}
		}
	}

	if match, ok := matchExcludedApp(f.config.ExcludedApps, sample.AppName, sample.AppExe); ok {
		return Decision{Allow: false, Reason: ReasonExcludedApp, Detail: match}
	}

	if match, ok := matchExcludedURL(f.config.ExcludedURLPatterns, sample.URLHost, sample.WindowTitle); ok {
		return Decision{Allow: false, Reason: ReasonExcludedURL, Detail: match}
	}

	return Decision{Allow: true, Reason: ReasonAllowed, Sample: f.scrub(sample)}
}

// scrub removes everything the configuration does not permit.
func (f *Filter) scrub(sample Sample) Sample {
	// Idle time is attributed to no application. This is a promise to employees — idle minutes
	// cannot be used to infer what was on screen — and it is enforced again by the database.
	if sample.IsIdle {
		sample.AppName = ""
		sample.AppExe = ""
		sample.WindowTitle = ""
		sample.URLHost = ""
		sample.URLTitle = ""
		return sample
	}

	if !f.config.CaptureWindowTitles {
		sample.WindowTitle = ""
	}

	if !f.config.CaptureURLs {
		sample.URLHost = ""
		sample.URLTitle = ""
	}

	return sample
}

// AllowScreenshot reports whether a screenshot may be taken at this instant.
//
// Separate from Decide because a screenshot is not a sample: it has no application attached at
// the point the decision is made, and it is governed by its own toggle. The work-hours check is
// the same one, deliberately reusing withinWorkHours so the two cannot diverge.
func (f *Filter) AllowScreenshot(now time.Time, screenshotEnabled bool) Decision {
	if !screenshotEnabled {
		return Decision{Allow: false, Reason: "screenshots are disabled", Detail: "screenshot_enabled=false"}
	}
	if f.config.WorkHoursOnly {
		if ok, reason, detail := f.withinWorkHours(now); !ok {
			return Decision{Allow: false, Reason: reason, Detail: detail}
		}
	}
	return Decision{Allow: true, Reason: ReasonAllowed}
}

// withinWorkHours evaluates the configured window in the employee's timezone.
//
// # The wrapping case
//
// A window where end <= start spans midnight — 22:00–06:00 for a night shift. That makes the
// working-day question subtler than it looks: at 01:00 on Tuesday, the relevant shift started
// on *Monday*. So for a wrapping window a sample is inside it when either
//
//   - the local time is at or after the start AND today is a working day (the evening half), or
//   - the local time is before the end AND *yesterday* was a working day (the morning half).
//
// Treating the morning half as belonging to today would mean a Monday-to-Friday night worker
// was monitored at 01:00 on Saturday (the tail of Friday's shift — correct) but not at 01:00 on
// Monday (the tail of Sunday, which is not a working day — also correct). Getting this wrong in
// the obvious way silently monitors people outside their shift, which is the direction that
// matters.
func (f *Filter) withinWorkHours(when time.Time) (bool, Reason, string) {
	local := when.In(f.location)
	nowTOD := timeOfDayAt(local)
	today := isoWeekday(local.Weekday())

	start, end := f.config.WorkHoursStart, f.config.WorkHoursEnd

	if end > start {
		// The ordinary same-day window.
		if !isWorkingDay(f.config.WorkDays, today) {
			return false, ReasonNonWorkingDay, local.Weekday().String()
		}
		if nowTOD < start || nowTOD >= end {
			return false, ReasonOutsideWorkHours,
				fmt.Sprintf("%s outside %s-%s", nowTOD, start, end)
		}
		return true, ReasonAllowed, ""
	}

	// Wrapping window (end <= start). start == end should never reach here — the server
	// rejects it — but if it did, treating it as wrapping means "never inside", which is the
	// safe direction.
	yesterday := isoWeekday(local.AddDate(0, 0, -1).Weekday())

	if nowTOD >= start && isWorkingDay(f.config.WorkDays, today) {
		return true, ReasonAllowed, ""
	}
	if nowTOD < end && isWorkingDay(f.config.WorkDays, yesterday) {
		return true, ReasonAllowed, ""
	}

	if !isWorkingDay(f.config.WorkDays, today) && !isWorkingDay(f.config.WorkDays, yesterday) {
		return false, ReasonNonWorkingDay, local.Weekday().String()
	}
	return false, ReasonOutsideWorkHours, fmt.Sprintf("%s outside %s-%s (overnight)", nowTOD, start, end)
}

// isWorkingDay reports whether an ISO weekday is configured as a working day.
//
// An empty WorkDays list means no day is a working day, so nothing is captured. That is the
// safe reading: the alternative — treating empty as "every day" — would turn a configuration
// mistake into unrestricted monitoring. The server's CHECK requires between 1 and 7 entries,
// so an empty list only arises from a bug, and a bug should fail closed.
func isWorkingDay(workDays []int, iso int) bool {
	for _, day := range workDays {
		if day == iso {
			return true
		}
	}
	return false
}

// matchExcludedApp reports the first matching exclusion, if any.
//
// Matching is case-insensitive substring against both the base name and the full path.
// Substring because a deployer should be able to write "bank" without knowing the executable
// name; the full path as well because an application can be identified by its install
// directory when its executable name is generic (electron.exe, javaw.exe).
func matchExcludedApp(patterns []string, appName, appExe string) (string, bool) {
	if appName == "" && appExe == "" {
		return "", false
	}

	lowerName := strings.ToLower(appName)
	lowerExe := strings.ToLower(appExe)
	lowerBase := strings.ToLower(filepath.Base(appExe))

	for _, pattern := range patterns {
		p := strings.ToLower(strings.TrimSpace(pattern))
		if p == "" {
			continue
		}
		if strings.Contains(lowerName, p) || strings.Contains(lowerExe, p) || strings.Contains(lowerBase, p) {
			return pattern, true
		}
	}
	return "", false
}

// matchExcludedURL reports the first matching exclusion, if any.
//
// Patterns are matched against the derived host and against the raw window title. Both,
// because the title frequently names the site even when no host could be derived from it —
// excluding "*bank*" has to suppress "Internet Banking - Chrome" as well as "anz.com.au", or
// the exclusion is decorative.
//
// A pattern with no wildcard is treated as a substring match, so "bank" behaves the way a
// deployer expects rather than only matching a host called exactly "bank".
func matchExcludedURL(patterns []string, urlHost, windowTitle string) (string, bool) {
	if urlHost == "" && windowTitle == "" {
		return "", false
	}

	lowerHost := strings.ToLower(urlHost)
	lowerTitle := strings.ToLower(windowTitle)

	for _, pattern := range patterns {
		p := strings.ToLower(strings.TrimSpace(pattern))
		if p == "" {
			continue
		}

		if strings.ContainsAny(p, "*?[") {
			if globMatch(p, lowerHost) || globMatch(p, lowerTitle) {
				return pattern, true
			}
			// A leading-wildcard host pattern such as "*.example.com" should also match the
			// bare domain "example.com", which is what a deployer means by it.
			if trimmed := strings.TrimPrefix(p, "*."); trimmed != p {
				if lowerHost == trimmed || strings.HasSuffix(lowerHost, "."+trimmed) {
					return pattern, true
				}
			}
			continue
		}

		if strings.Contains(lowerHost, p) || strings.Contains(lowerTitle, p) {
			return pattern, true
		}
	}
	return "", false
}

// globMatch is filepath.Match without treating a separator specially.
//
// filepath.Match refuses to let `*` cross a path separator, which on a host or a title is the
// wrong behaviour: "*.example.com" must match "www.example.com", and on Windows a title
// containing a backslash must not stop a wildcard. A malformed pattern returns false rather
// than an error — an unusable exclusion pattern must not be able to crash the capture loop, and
// failing to match is the conservative outcome only because the substring path above already
// caught the common cases.
func globMatch(pattern, value string) bool {
	if pattern == "" || value == "" {
		return false
	}
	ok, err := filepath.Match(pattern, value)
	if err != nil {
		return false
	}
	if ok {
		return true
	}
	// Retry with separators neutralised, so a wildcard spans dots and slashes.
	return matchAcrossSeparators(pattern, value)
}

// matchAcrossSeparators implements `*`, `?` and `[...]` where `*` matches any run of
// characters including separators. Iterative, so a pathological pattern cannot blow the stack.
func matchAcrossSeparators(pattern, value string) bool {
	p, v := 0, 0
	starP, starV := -1, -1

	for v < len(value) {
		switch {
		case p < len(pattern) && (pattern[p] == '?' || pattern[p] == value[v]):
			p++
			v++
		case p < len(pattern) && pattern[p] == '*':
			starP = p
			p++
			starV = v
		case p < len(pattern) && pattern[p] == '[':
			end := strings.IndexByte(pattern[p:], ']')
			if end < 0 {
				return false
			}
			class := pattern[p+1 : p+end]
			if matchClass(class, value[v]) {
				p += end + 1
				v++
				continue
			}
			if starP < 0 {
				return false
			}
			starV++
			v = starV
			p = starP + 1
		case starP >= 0:
			starV++
			v = starV
			p = starP + 1
		default:
			return false
		}
	}

	for p < len(pattern) && pattern[p] == '*' {
		p++
	}
	return p == len(pattern)
}

// matchClass evaluates a `[abc]` or `[a-z]` character class, with `!` or `^` for negation.
func matchClass(class string, c byte) bool {
	negated := false
	if strings.HasPrefix(class, "!") || strings.HasPrefix(class, "^") {
		negated = true
		class = class[1:]
	}

	matched := false
	for i := 0; i < len(class); i++ {
		if i+2 < len(class) && class[i+1] == '-' {
			if c >= class[i] && c <= class[i+2] {
				matched = true
			}
			i += 2
			continue
		}
		if class[i] == c {
			matched = true
		}
	}
	return matched != negated
}
