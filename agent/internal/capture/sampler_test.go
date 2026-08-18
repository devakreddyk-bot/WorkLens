package capture

import (
	"errors"
	"fmt"
	"image"
	"strings"
	"testing"
	"time"

	"github.com/worklens/worklens/agent/internal/platform"
)

// fakePlatform stands in for the operating system. It exists so that every rule in
// sampler.go is testable on the machine the agent is developed on (macOS) rather than only
// on Windows, which is the reason the Platform seam exists at all.
type fakePlatform struct {
	win     platform.WindowInfo
	winErr  error
	idle    time.Duration
	idleErr error
	closed  int
}

func (f *fakePlatform) ActiveWindow() (platform.WindowInfo, error) {
	return f.win, f.winErr
}

func (f *fakePlatform) IdleDuration() (time.Duration, error) {
	return f.idle, f.idleErr
}

func (f *fakePlatform) CaptureScreen() (image.Image, error) {
	return image.NewRGBA(image.Rect(0, 0, 1, 1)), nil
}

func (f *fakePlatform) Close() error {
	f.closed++
	return nil
}

// fakeClock is advanced explicitly by the test, so no assertion depends on wall time.
type fakeClock struct{ t time.Time }

func (c *fakeClock) Now() time.Time          { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }
func newClock() *fakeClock                   { return &fakeClock{t: time.Date(2026, 3, 4, 9, 0, 0, 0, time.UTC)} }

const testInterval = 60 * time.Second

func testConfig() Config {
	return Config{
		SampleInterval:      testInterval,
		IdleThreshold:       5 * time.Minute,
		CaptureWindowTitles: true,
		CaptureURLs:         true,
	}
}

func newTestSampler(t *testing.T, plat platform.Platform, clk *fakeClock, cfg Config) *Sampler {
	t.Helper()
	s, err := NewSampler(plat, clk.Now, cfg)
	if err != nil {
		t.Fatalf("NewSampler: %v", err)
	}
	return s
}

// tickN drives n ticks, advancing the clock by one interval before each tick after the
// first, and returns every completed sample.
func tickN(t *testing.T, s *Sampler, clk *fakeClock, n int) []Sample {
	t.Helper()
	var out []Sample
	for i := 0; i < n; i++ {
		if i > 0 {
			clk.advance(testInterval)
		}
		sample, ok, err := s.Tick()
		if err != nil {
			t.Fatalf("tick %d: %v", i, err)
		}
		if ok {
			out = append(out, sample)
		}
	}
	return out
}

func TestNewSamplerRejectsMissingDependencies(t *testing.T) {
	if _, err := NewSampler(nil, time.Now, testConfig()); err == nil {
		t.Fatal("expected an error when the platform is nil")
	}
	if _, err := NewSampler(&fakePlatform{}, nil, testConfig()); err == nil {
		t.Fatal("expected an error when the clock is nil")
	}
}

func TestConfigDefaultsApplied(t *testing.T) {
	s, err := NewSampler(&fakePlatform{}, newClock().Now, Config{})
	if err != nil {
		t.Fatalf("NewSampler: %v", err)
	}
	if s.cfg.SampleInterval != DefaultSampleInterval {
		t.Errorf("SampleInterval = %v, want %v", s.cfg.SampleInterval, DefaultSampleInterval)
	}
	if s.cfg.IdleThreshold != DefaultIdleThreshold {
		t.Errorf("IdleThreshold = %v, want %v", s.cfg.IdleThreshold, DefaultIdleThreshold)
	}

	// A misconfigured interval longer than the schema's duration cap would make every
	// single sample unrepresentable, so it is clamped rather than passed through.
	s2, err := NewSampler(&fakePlatform{}, newClock().Now, Config{SampleInterval: 10 * time.Hour})
	if err != nil {
		t.Fatalf("NewSampler: %v", err)
	}
	if s2.cfg.SampleInterval != MaxSampleDuration {
		t.Errorf("SampleInterval = %v, want it clamped to %v", s2.cfg.SampleInterval, MaxSampleDuration)
	}
}

// TestIdleSampleCarriesNoAttribution is the test that stands in for
// activity_events_idle_no_attribution_chk. If it fails, the server rejects the entire
// upload batch and the guarantee that idle minutes cannot reveal what was on screen is
// broken.
func TestIdleSampleCarriesNoAttribution(t *testing.T) {
	clk := newClock()
	plat := &fakePlatform{
		idle: 20 * time.Minute,
		win: platform.WindowInfo{
			AppName:     "chrome.exe",
			AppExe:      `C:\Program Files\Google\Chrome\Application\chrome.exe`,
			WindowTitle: "Payroll - internal.example.com - Google Chrome",
		},
	}
	s := newTestSampler(t, plat, clk, testConfig())

	// Two idle intervals, then a change back to active so the idle span is emitted.
	tickN(t, s, clk, 2)
	plat.idle = 0
	clk.advance(testInterval)
	idleSample, ok, err := s.Tick()
	if err != nil {
		t.Fatalf("tick: %v", err)
	}
	if !ok {
		t.Fatal("expected the idle span to be emitted when activity resumed")
	}

	if !idleSample.IsIdle {
		t.Fatal("sample should be idle")
	}
	if !idleSample.App.IsZero() {
		t.Errorf("idle sample carries app attribution: %+v", idleSample.App)
	}
	if idleSample.URLHost != "" || idleSample.URLTitle != "" {
		t.Errorf("idle sample carries URL attribution: host=%q title=%q", idleSample.URLHost, idleSample.URLTitle)
	}

	// And the open sample that replaced it must have picked the attribution back up, so
	// the suppression is per-sample and not sticky.
	open, ok := s.Open()
	if !ok {
		t.Fatal("expected an open sample after resuming activity")
	}
	if open.IsIdle || open.App.AppName != "chrome.exe" {
		t.Errorf("post-idle sample = %+v, want active chrome.exe", open)
	}
}

func TestIdleThresholdBoundary(t *testing.T) {
	cfg := testConfig()
	for _, tc := range []struct {
		name   string
		idle   time.Duration
		isIdle bool
	}{
		{"just under the threshold", cfg.IdleThreshold - time.Millisecond, false},
		{"exactly at the threshold", cfg.IdleThreshold, true},
		{"well over the threshold", 2 * cfg.IdleThreshold, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			clk := newClock()
			plat := &fakePlatform{idle: tc.idle, win: platform.WindowInfo{AppName: "code.exe"}}
			s := newTestSampler(t, plat, clk, cfg)
			tickN(t, s, clk, 1)
			open, _ := s.Open()
			if open.IsIdle != tc.isIdle {
				t.Errorf("IsIdle = %v, want %v for idle=%v", open.IsIdle, tc.isIdle, tc.idle)
			}
		})
	}
}

func TestConsecutiveIdenticalSamplesCoalesce(t *testing.T) {
	clk := newClock()
	plat := &fakePlatform{win: platform.WindowInfo{AppName: "excel.exe", WindowTitle: "Q3 forecast.xlsx"}}
	s := newTestSampler(t, plat, clk, testConfig())

	if emitted := tickN(t, s, clk, 5); len(emitted) != 0 {
		t.Fatalf("5 identical ticks emitted %d samples, want 0 (they must coalesce)", len(emitted))
	}

	open, ok := s.Open()
	if !ok {
		t.Fatal("expected an open sample")
	}
	if want := 5 * testInterval; open.Duration != want {
		t.Errorf("Duration = %v, want %v", open.Duration, want)
	}
	// The coalesced sample is stamped with the start of the span, not its end.
	if !open.CapturedAt.Equal(newClock().t) {
		t.Errorf("CapturedAt = %v, want the first tick's time %v", open.CapturedAt, newClock().t)
	}
}

func TestChangeOfApplicationEmitsThePreviousSpan(t *testing.T) {
	clk := newClock()
	plat := &fakePlatform{win: platform.WindowInfo{AppName: "code.exe", WindowTitle: "sampler.go"}}
	s := newTestSampler(t, plat, clk, testConfig())
	tickN(t, s, clk, 3)

	plat.win = platform.WindowInfo{AppName: "slack.exe", WindowTitle: "#engineering"}
	clk.advance(testInterval)
	emitted, ok, err := s.Tick()
	if err != nil {
		t.Fatalf("tick: %v", err)
	}
	if !ok {
		t.Fatal("a change of application must emit the previous span")
	}
	if emitted.App.AppName != "code.exe" || emitted.Duration != 3*testInterval {
		t.Errorf("emitted = %+v, want code.exe for %v", emitted, 3*testInterval)
	}
}

// A changed window title inside the same application is a different span: the same editor
// on a different file, or the same browser on a different page.
func TestChangeOfTitleAloneEmits(t *testing.T) {
	clk := newClock()
	plat := &fakePlatform{win: platform.WindowInfo{AppName: "code.exe", WindowTitle: "sampler.go"}}
	s := newTestSampler(t, plat, clk, testConfig())
	tickN(t, s, clk, 1)

	plat.win.WindowTitle = "url.go"
	clk.advance(testInterval)
	emitted, ok, _ := s.Tick()
	if !ok || emitted.App.WindowTitle != "sampler.go" {
		t.Errorf("emitted = %+v, ok = %v; want the sampler.go span closed", emitted, ok)
	}
}

// TestDurationIsCappedAtTheSchemaLimit protects the whole batch: duration_seconds has a
// CHECK for 0..3600 and one over-long event fails the insert for every event beside it.
func TestDurationIsCappedAtTheSchemaLimit(t *testing.T) {
	clk := newClock()
	plat := &fakePlatform{win: platform.WindowInfo{AppName: "idea64.exe", WindowTitle: "worklens"}}
	s := newTestSampler(t, plat, clk, testConfig())

	// 60 ticks of 60s fill the hour exactly; the 61st cannot fit and must close the span.
	ticks := int(MaxSampleDuration/testInterval) + 1
	emitted := tickN(t, s, clk, ticks)
	if len(emitted) != 1 {
		t.Fatalf("emitted %d samples over %d ticks, want exactly 1 at the cap", len(emitted), ticks)
	}
	if emitted[0].Duration != MaxSampleDuration {
		t.Errorf("Duration = %v, want exactly the cap %v", emitted[0].Duration, MaxSampleDuration)
	}
	if secs := int64(emitted[0].Duration.Seconds()); secs > 3600 {
		t.Errorf("duration_seconds = %d, which violates the 0..3600 CHECK constraint", secs)
	}

	// The tick that could not fit opened a new span rather than being dropped.
	open, ok := s.Open()
	if !ok || open.Duration != testInterval {
		t.Errorf("open = %+v, ok = %v; want a fresh span of %v", open, ok, testInterval)
	}
	// Every emitted sample, always, for any run length.
	for i, sample := range append(emitted, open) {
		if sample.Duration > MaxSampleDuration {
			t.Errorf("sample %d duration %v exceeds the cap", i, sample.Duration)
		}
	}
}

func TestFlushClosesTheOpenSpan(t *testing.T) {
	clk := newClock()
	plat := &fakePlatform{win: platform.WindowInfo{AppName: "outlook.exe"}}
	s := newTestSampler(t, plat, clk, testConfig())

	if _, ok := s.Flush(); ok {
		t.Fatal("Flush on a fresh sampler must report nothing to flush")
	}

	tickN(t, s, clk, 2)
	flushed, ok := s.Flush()
	if !ok {
		t.Fatal("Flush must return the open span")
	}
	if flushed.Duration != 2*testInterval || flushed.App.AppName != "outlook.exe" {
		t.Errorf("flushed = %+v, want outlook.exe for %v", flushed, 2*testInterval)
	}
	if _, ok := s.Flush(); ok {
		t.Fatal("a second Flush must report nothing — the span was already emitted once")
	}
	if _, ok := s.Open(); ok {
		t.Fatal("Flush must clear the open span, or the next tick double-counts it")
	}
}

func TestWindowTitlesSuppressedWhenDisabled(t *testing.T) {
	cfg := testConfig()
	cfg.CaptureWindowTitles = false
	clk := newClock()
	plat := &fakePlatform{win: platform.WindowInfo{
		AppName:     "chrome.exe",
		AppExe:      `C:\chrome.exe`,
		WindowTitle: "Salary review - hr.example.com - Google Chrome",
	}}
	s := newTestSampler(t, plat, clk, cfg)
	tickN(t, s, clk, 1)

	open, _ := s.Open()
	if open.App.WindowTitle != "" {
		t.Errorf("WindowTitle = %q, want empty when capture_window_titles is off", open.App.WindowTitle)
	}
	if open.App.AppName != "chrome.exe" {
		t.Errorf("AppName = %q, want the app to still be attributed", open.App.AppName)
	}
	// URL derivation reads the title, so it must be off too — otherwise the agent would be
	// reading titles behind the back of the setting that says not to.
	if open.URLHost != "" || open.URLTitle != "" {
		t.Errorf("URL fields = (%q, %q), want empty when titles are disabled", open.URLHost, open.URLTitle)
	}
}

func TestURLFieldsSuppressedWhenURLCaptureDisabled(t *testing.T) {
	cfg := testConfig()
	cfg.CaptureURLs = false
	clk := newClock()
	plat := &fakePlatform{win: platform.WindowInfo{
		AppName:     "chrome.exe",
		WindowTitle: "Docs - docs.example.com - Google Chrome",
	}}
	s := newTestSampler(t, plat, clk, cfg)
	tickN(t, s, clk, 1)

	open, _ := s.Open()
	if open.URLHost != "" || open.URLTitle != "" {
		t.Errorf("URL fields = (%q, %q), want empty when capture_urls is off", open.URLHost, open.URLTitle)
	}
	if open.App.WindowTitle == "" {
		t.Error("the window title should still be captured — only URL derivation is off")
	}
}

func TestURLDerivedWhenEnabled(t *testing.T) {
	clk := newClock()
	plat := &fakePlatform{win: platform.WindowInfo{
		AppName:     "chrome.exe",
		WindowTitle: "Lambda quotas - docs.aws.amazon.com - Google Chrome",
	}}
	s := newTestSampler(t, plat, clk, testConfig())
	tickN(t, s, clk, 1)

	open, _ := s.Open()
	if open.URLHost != "docs.aws.amazon.com" {
		t.Errorf("URLHost = %q, want docs.aws.amazon.com", open.URLHost)
	}
	if open.URLTitle != "Lambda quotas - docs.aws.amazon.com" {
		t.Errorf("URLTitle = %q", open.URLTitle)
	}
}

func TestNoActiveWindowIsRecordedAsUnattributedTime(t *testing.T) {
	clk := newClock()
	plat := &fakePlatform{winErr: platform.ErrNoActiveWindow}
	s := newTestSampler(t, plat, clk, testConfig())

	if _, _, err := s.Tick(); err != nil {
		t.Fatalf("a locked screen must not be an error: %v", err)
	}
	open, ok := s.Open()
	if !ok {
		t.Fatal("expected a sample: the time is real even with nothing focused")
	}
	if open.IsIdle {
		t.Error("nothing focused is not the same as idle — the user was still providing input")
	}
	if !open.App.IsZero() {
		t.Errorf("App = %+v, want no attribution", open.App)
	}
}

func TestPlatformErrorLeavesTheOpenSpanIntact(t *testing.T) {
	clk := newClock()
	plat := &fakePlatform{win: platform.WindowInfo{AppName: "word.exe"}}
	s := newTestSampler(t, plat, clk, testConfig())
	tickN(t, s, clk, 2)

	boom := errors.New("RPC server unavailable")
	plat.winErr = boom
	clk.advance(testInterval)
	sample, ok, err := s.Tick()
	if err == nil {
		t.Fatal("expected the platform error to be reported")
	}
	if !errors.Is(err, boom) {
		t.Errorf("error %v does not wrap the cause", err)
	}
	if ok {
		t.Errorf("no sample may be emitted on error, got %+v", sample)
	}

	plat.winErr = nil
	clk.advance(testInterval)
	tickN(t, s, clk, 1)
	open, _ := s.Open()
	// The failed tick cost one interval of accounted time and nothing else: the span was
	// neither split nor misattributed.
	if open.Duration != 3*testInterval || open.App.AppName != "word.exe" {
		t.Errorf("open = %+v, want word.exe for %v", open, 3*testInterval)
	}
}

func TestIdleReadErrorIsReported(t *testing.T) {
	clk := newClock()
	plat := &fakePlatform{idleErr: errors.New("no session")}
	s := newTestSampler(t, plat, clk, testConfig())
	if _, ok, err := s.Tick(); err == nil || ok {
		t.Fatalf("expected an error and no sample, got ok=%v err=%v", ok, err)
	}
}

// The server's CHECK constraints cap every text column. Truncating here rather than
// discovering it as a 400 keeps one pathological window title from failing a whole batch.
func TestOverlongFieldsAreTruncatedToTheSchemaLimits(t *testing.T) {
	clk := newClock()
	plat := &fakePlatform{win: platform.WindowInfo{
		AppName:     strings.Repeat("a", MaxAppNameLen+50) + ".exe",
		AppExe:      `C:\` + strings.Repeat("b", MaxAppExeLen+50),
		WindowTitle: strings.Repeat("\u00e9", MaxWindowTitleLen+50),
	}}
	s := newTestSampler(t, plat, clk, testConfig())
	tickN(t, s, clk, 1)

	open, _ := s.Open()
	for _, tc := range []struct {
		field string
		value string
		max   int
	}{
		{"app_name", open.App.AppName, MaxAppNameLen},
		{"app_exe", open.App.AppExe, MaxAppExeLen},
		{"window_title", open.App.WindowTitle, MaxWindowTitleLen},
	} {
		// Postgres length() counts characters, so the assertion is on runes.
		if got := len([]rune(tc.value)); got != tc.max {
			t.Errorf("%s length = %d characters, want %d", tc.field, got, tc.max)
		}
		if !utf8Valid(tc.value) {
			t.Errorf("%s was cut mid-character", tc.field)
		}
	}
}

func utf8Valid(s string) bool {
	for _, r := range s {
		if r == '\uFFFD' {
			return false
		}
	}
	return true
}

// A long uninterrupted stretch produces a series of capped samples whose durations sum to
// the elapsed time: no interval is invented and none is lost.
func TestNoTimeIsInventedOrLostAcrossManyTicks(t *testing.T) {
	clk := newClock()
	plat := &fakePlatform{win: platform.WindowInfo{AppName: "teams.exe"}}
	s := newTestSampler(t, plat, clk, testConfig())

	const ticks = 250
	emitted := tickN(t, s, clk, ticks)
	final, _ := s.Flush()

	var total time.Duration
	for _, sample := range append(emitted, final) {
		if sample.Duration <= 0 || sample.Duration > MaxSampleDuration {
			t.Fatalf("implausible duration %v", sample.Duration)
		}
		total += sample.Duration
	}
	if want := ticks * testInterval; total != want {
		t.Errorf("total accounted time = %v, want %v", total, want)
	}
}

func ExampleSampler_Tick() {
	plat := &fakePlatform{win: platform.WindowInfo{AppName: "chrome.exe", WindowTitle: "Timesheets - Google Chrome"}}
	clk := newClock()
	s, err := NewSampler(plat, clk.Now, Config{SampleInterval: time.Minute, IdleThreshold: 5 * time.Minute, CaptureWindowTitles: true})
	if err != nil {
		panic(err)
	}
	_, emitted, _ := s.Tick()
	fmt.Println("first tick emitted:", emitted)
	open, _ := s.Open()
	fmt.Println("open span:", open.App.AppName, open.Duration)
	// Output:
	// first tick emitted: false
	// open span: chrome.exe 1m0s
}
