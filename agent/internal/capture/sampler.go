// Package capture turns operating-system observations into the activity samples that
// eventually become activity_events rows.
//
// It contains the agent's only real state machine, and it is written to be a pure one: the
// clock and the platform are injected, nothing here calls time.Now, and nothing here does
// I/O. Every rule below — idle suppression, coalescing, the duration cap — is therefore a
// table-driven unit test that runs on any developer machine, which is the point, because
// these rules are also enforced by CHECK constraints on the server and a violation costs
// an entire rejected upload batch rather than one bad row.
//
// Three invariants this package is responsible for:
//
//   - An idle sample carries no attribution at all. No app, no executable, no window
//     title, no host. `activity_events_idle_no_attribution_chk` rejects the whole batch
//     otherwise, and the promise in docs/RESPONSIBLE_USE.md is that idle minutes cannot be
//     used to work out what was on screen.
//   - Consecutive identical samples coalesce into one sample with a summed duration. On
//     typical usage this reduces event volume by roughly 10-20x, which is what keeps the
//     local SQLite buffer small enough to survive a long offline stretch.
//   - No sample's duration exceeds MaxSampleDuration. duration_seconds has a CHECK for
//     0..3600 on the server.
//
// # URL capture limits (deviation D9)
//
// URLs are derived from the browser's *window title* and nothing else. See url.go: the
// method yields a page title and, when the title happens to contain a domain, a host. It
// can never yield a path or a query string, and often it cannot yield a host at all — in
// which case this package reports none rather than inferring one. Reading true URLs would
// require a browser extension talking to the agent; that is deliberately not built,
// because it would widen what is collected from "the caption the employee can already see
// in their own title bar" to "every address they visit".
package capture

import (
	"errors"
	"fmt"
	"time"

	"github.com/worklens/worklens/agent/internal/platform"
)

// MaxSampleDuration is the longest span a single sample may cover.
//
// It exists because activity_events.duration_seconds is constrained to 0..3600 on the
// server: one hour, chosen there so that a stalled clock or a laptop resumed from sleep
// cannot inject an implausible span into a timesheet. When coalescing would push a sample
// past this, the sampler closes it and opens a new one, so a genuinely long stretch in one
// application becomes several hour-long samples rather than one rejected batch.
const MaxSampleDuration = time.Hour

// Field length limits, mirroring the CHECK constraints on activity_events. Values are
// truncated to these lengths here, at the point of capture, because the server rejects the
// entire batch if one field in one event is too long — and the field most likely to run
// long is a window title, which is also the one whose tail matters least.
const (
	MaxAppNameLen     = 200
	MaxAppExeLen      = 400
	MaxWindowTitleLen = 500
	MaxURLHostLen     = 253
	MaxURLTitleLen    = 500
)

// Default sampling parameters, matching the monitoring_config column defaults so that an
// agent running before its first successful config fetch behaves the same as one that has
// fetched the defaults.
const (
	DefaultSampleInterval = 60 * time.Second
	DefaultIdleThreshold  = 5 * time.Minute
)

// Sample is one span of observed activity.
//
// It maps onto an activity_events row of type window_sample. The zero App together with
// IsIdle true is the shape of an idle span, and it is the only shape an idle span may have.
type Sample struct {
	// CapturedAt is the moment the span started — the tick that opened it, not the tick
	// that closed it. A coalesced sample therefore reads as "starting here, for this long",
	// which is what the aggregation job assumes when it slices a day into buckets.
	CapturedAt time.Time

	// Duration is the wall time this sample covers, never more than MaxSampleDuration.
	Duration time.Duration

	// IsIdle is true when the last user input was longer ago than the configured idle
	// threshold.
	IsIdle bool

	// App is the foreground application. It MUST be the zero WindowInfo when IsIdle is
	// true; see the package documentation.
	App platform.WindowInfo

	// URLHost is the host derived from a browser window title, when one could be derived
	// with confidence. Empty otherwise — including when the browser is on a page whose
	// title contains no domain, which is most pages.
	URLHost string

	// URLTitle is the page title with the browser's own suffix stripped.
	URLTitle string
}

// Config is the subset of monitoring_config the sampler needs.
//
// It is passed by value at construction rather than read from a shared pointer: a config
// reload replaces the sampler's config through NewSampler on the next cycle, so a sample
// can never be observed under one setting and recorded under another.
type Config struct {
	// SampleInterval is how often Tick is expected to be called. It is also the wall time
	// each tick is taken to represent, which is why the sampler needs to know it rather
	// than measuring elapsed time itself.
	SampleInterval time.Duration

	// IdleThreshold is how long without input counts as idle.
	IdleThreshold time.Duration

	// CaptureWindowTitles mirrors monitoring_config.capture_window_titles.
	CaptureWindowTitles bool

	// CaptureURLs mirrors monitoring_config.capture_urls. It has no effect unless
	// CaptureWindowTitles is also set: the host is derived from the title, so URL capture
	// without title capture would mean reading titles behind the back of the setting that
	// says not to.
	CaptureURLs bool
}

// withDefaults fills in zero values so that a Config built before the first config fetch
// is usable rather than degenerate (a zero SampleInterval would make every sample
// zero-length; a zero IdleThreshold would mark every sample idle).
func (c Config) withDefaults() Config {
	if c.SampleInterval <= 0 {
		c.SampleInterval = DefaultSampleInterval
	}
	if c.IdleThreshold <= 0 {
		c.IdleThreshold = DefaultIdleThreshold
	}
	if c.SampleInterval > MaxSampleDuration {
		c.SampleInterval = MaxSampleDuration
	}
	return c
}

// Sampler observes the machine once per tick and emits coalesced samples.
//
// It is not safe for concurrent use. The agent drives it from a single ticker goroutine
// under the supervisor, and giving it a mutex would only hide a caller that had started
// two sampling loops — which is a bug worth failing loudly on rather than serialising.
type Sampler struct {
	plat platform.Platform
	now  func() time.Time
	cfg  Config

	// open is the sample currently accumulating. Consecutive ticks that observe the same
	// thing extend it instead of producing a new sample.
	open *Sample
}

// NewSampler returns a Sampler that reads from plat and takes the current time from now.
//
// Both dependencies are injected rather than reached for. That is what lets every rule in
// this file be tested on a developer's Mac against a fake platform and a scripted clock —
// including the cases that are almost impossible to produce on real hardware, such as the
// duration cap being reached or the tick-count wrap in idle detection.
func NewSampler(plat platform.Platform, now func() time.Time, cfg Config) (*Sampler, error) {
	if plat == nil {
		return nil, fmt.Errorf("capture: NewSampler: platform is required")
	}
	if now == nil {
		return nil, fmt.Errorf("capture: NewSampler: clock is required")
	}
	return &Sampler{plat: plat, now: now, cfg: cfg.withDefaults()}, nil
}

// Tick takes one observation and returns at most one completed sample.
//
// The second return value reports whether a sample was completed by this tick: a tick that
// observes the same thing as the previous one extends the open sample and completes
// nothing, which is the coalescing that reduces event volume by 10-20x. A completed sample
// is returned when the observation changes, or when extending the open sample would push
// it past MaxSampleDuration.
//
// On error nothing is emitted and the open sample is left untouched, so a transient
// failure to read the foreground window costs one interval of accounted time rather than
// splitting a span or, worse, attributing the interval to the wrong application.
// Under-counting is the correct direction to fail in: a missing minute is explainable, a
// misattributed minute is a false accusation.
func (s *Sampler) Tick() (Sample, bool, error) {
	observed, err := s.observe()
	if err != nil {
		return Sample{}, false, err
	}

	if s.open == nil {
		s.open = &observed
		return Sample{}, false, nil
	}

	if sameAttribution(*s.open, observed) {
		if s.open.Duration+s.cfg.SampleInterval <= MaxSampleDuration {
			s.open.Duration += s.cfg.SampleInterval
			return Sample{}, false, nil
		}
		// Cap reached. Close the open sample at the cap and start a fresh one for this
		// tick, rather than dropping the interval or emitting an over-long duration the
		// server would reject.
		completed := *s.open
		s.open = &observed
		return completed, true, nil
	}

	completed := *s.open
	s.open = &observed
	return completed, true, nil
}

// Flush closes and returns the open sample, if there is one.
//
// Callers need this in two situations: at shutdown, so the span the employee was in the
// middle of is recorded rather than discarded (session_end with a missing final span reads
// as an unexplained gap in a timesheet), and before an upload, so the batch reflects
// activity up to the moment it was sent instead of up to the last change of application —
// which on a long stretch of one app could be hours earlier.
func (s *Sampler) Flush() (Sample, bool) {
	if s.open == nil {
		return Sample{}, false
	}
	completed := *s.open
	s.open = nil
	return completed, true
}

// Open reports the sample currently accumulating, without closing it. Intended for the
// tray's "what is being recorded right now" display and for `agentctl doctor`.
func (s *Sampler) Open() (Sample, bool) {
	if s.open == nil {
		return Sample{}, false
	}
	return *s.open, true
}

// observe takes a single reading of the machine and shapes it into a one-interval Sample.
func (s *Sampler) observe() (Sample, error) {
	idle, err := s.plat.IdleDuration()
	if err != nil {
		return Sample{}, fmt.Errorf("capture: read idle duration: %w", err)
	}

	sample := Sample{
		CapturedAt: s.now(),
		Duration:   s.cfg.SampleInterval,
		IsIdle:     idle >= s.cfg.IdleThreshold,
	}

	if sample.IsIdle {
		// The foreground window is not even asked for while idle. Dropping the answer
		// afterwards would satisfy the schema, but not asking is a stronger property: an
		// idle sample cannot leak what was on screen because the agent never learned it.
		return sample, nil
	}

	win, err := s.plat.ActiveWindow()
	switch {
	case err == nil:
		// Attribution available.
	case errors.Is(err, platform.ErrNoActiveWindow):
		// The user is active but nothing has focus — a lock screen, a desktop switch, the
		// instant after an app exits. The time is real and is recorded as active; there is
		// simply nothing to attribute it to, which the schema allows (all attribution
		// columns are nullable).
		return sample, nil
	default:
		return Sample{}, fmt.Errorf("capture: read active window: %w", err)
	}

	if !s.cfg.CaptureWindowTitles {
		win.WindowTitle = ""
	}

	sample.App = platform.WindowInfo{
		AppName:     truncateRunes(win.AppName, MaxAppNameLen),
		AppExe:      truncateRunes(win.AppExe, MaxAppExeLen),
		WindowTitle: truncateRunes(win.WindowTitle, MaxWindowTitleLen),
	}

	if s.cfg.CaptureURLs && s.cfg.CaptureWindowTitles {
		host, pageTitle := DeriveBrowserURL(win.AppName, win.WindowTitle)
		sample.URLHost = truncateRunes(host, MaxURLHostLen)
		sample.URLTitle = truncateRunes(pageTitle, MaxURLTitleLen)
	}

	return enforceIdleInvariant(sample), nil
}

// enforceIdleInvariant strips attribution from an idle sample.
//
// observe never produces an idle sample with attribution, so this is belt and braces — and
// worth having, because the failure mode it guards against is not a wrong number in a
// dashboard but a rejected upload batch and a broken promise to the employee. It is cheap
// enough to run on every sample and it means a future edit to observe cannot quietly
// violate the invariant.
func enforceIdleInvariant(s Sample) Sample {
	if !s.IsIdle {
		return s
	}
	s.App = platform.WindowInfo{}
	s.URLHost = ""
	s.URLTitle = ""
	return s
}

// sameAttribution reports whether two observations describe the same thing and may
// therefore be coalesced.
//
// Every recorded field is compared, not a subset: coalescing on app alone would merge two
// different documents in the same editor into one span, and coalescing on title alone would
// merge two applications that happen to share a caption. Comparing everything means a
// coalesced sample is always an exact statement about the whole interval it covers.
func sameAttribution(a, b Sample) bool {
	return a.IsIdle == b.IsIdle &&
		a.App == b.App &&
		a.URLHost == b.URLHost &&
		a.URLTitle == b.URLTitle
}

// truncateRunes shortens s to at most max characters.
//
// Characters, not bytes: the server's CHECK constraints use Postgres length(), which counts
// characters, and a window title is very often not ASCII. Cutting on a rune boundary also
// avoids handing the server a string ending in half a UTF-8 sequence.
func truncateRunes(s string, max int) string {
	if max <= 0 || len(s) <= max {
		// len(s) <= max implies at most max runes, so the common case costs one comparison.
		return s
	}
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max])
}
