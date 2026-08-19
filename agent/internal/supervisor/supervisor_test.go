package supervisor

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/worklens/worklens/agent/internal/logging"
)

// Not one of these tests sleeps. The clock is injected, so a restart policy that would take
// twenty-five minutes of wall time on a real agent is asserted exactly, in microseconds, and
// cannot flake on a loaded CI runner. See the package documentation.

// fakeClock records every delay it is asked to wait for and advances its own notion of now by
// that amount, which is what makes the failure-window arithmetic observable.
type fakeClock struct {
	mu    sync.Mutex
	now   time.Time
	waits []time.Duration

	// onWait runs before each wait returns, with the supervisor's lock not held. Tests use it
	// to cancel mid-backoff.
	onWait func(d time.Duration)
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 3, 17, 9, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func (c *fakeClock) Wait(ctx context.Context, d time.Duration) error {
	c.mu.Lock()
	c.waits = append(c.waits, d)
	c.now = c.now.Add(d)
	hook := c.onWait
	c.mu.Unlock()

	if hook != nil {
		hook(d)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return nil
}

func (c *fakeClock) recorded() []time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]time.Duration(nil), c.waits...)
}

// counter counts calls without a data race, since the supervised function runs on its own
// goroutine and the assertions run on the test's.
type counter struct {
	mu sync.Mutex
	n  int
}

func (c *counter) inc() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.n++
	return c.n
}

func (c *counter) get() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n
}

// testConfig is a supervisor whose every timing decision is fixed: no jitter, a known clock.
func testConfig(clock Clock) Config {
	return Config{
		MinBackoff:    time.Second,
		MaxBackoff:    time.Minute,
		Jitter:        0, // asserted separately; the rest of the suite wants exact delays
		MaxFailures:   3,
		FailureWindow: 10 * time.Minute,
		Clock:         clock,
		Rand:          func() float64 { return 0.5 },
	}
}

// bufferLogger returns a logger writing JSON lines into buf. Read buf only after Wait has
// returned, which is the point at which the supervisor's goroutines are known to be finished.
func bufferLogger(t *testing.T, buf *bytes.Buffer) *logging.Logger {
	t.Helper()
	logger, err := logging.New(logging.Options{Level: logging.LevelDebug, Stderr: buf})
	if err != nil {
		t.Fatalf("building the test logger: %v", err)
	}
	t.Cleanup(func() { _ = logger.Close() })
	return logger
}

// ---------------------------------------------------------------------------
// Restart behaviour
// ---------------------------------------------------------------------------

func TestPanickingLoopIsRestartedThenAbandoned(t *testing.T) {
	clock := newFakeClock()
	sup := New(context.Background(), testConfig(clock))

	var calls counter
	sup.Go("sampler", func(context.Context) error {
		calls.inc()
		panic("foreground window handle went away")
	})

	err := sup.Wait()

	// MaxFailures is 3, so: run, fail, back off; run, fail, back off; run, fail, give up.
	if got := calls.get(); got != 3 {
		t.Errorf("the loop ran %d times, want 3 (MaxFailures)", got)
	}
	if !errors.Is(err, ErrGaveUp) {
		t.Fatalf("Wait returned %v, want an error matching ErrGaveUp", err)
	}

	var gaveUp *GaveUpError
	if !errors.As(err, &gaveUp) {
		t.Fatalf("Wait returned %v, want a *GaveUpError", err)
	}
	if gaveUp.Name != "sampler" {
		t.Errorf("the abandonment names %q, want %q", gaveUp.Name, "sampler")
	}

	var panicked *PanicError
	if !errors.As(err, &panicked) {
		t.Fatalf("the panic should still be reachable through the error chain: %v", err)
	}
	if !strings.Contains(panicked.Error(), "foreground window handle went away") {
		t.Errorf("the panic value was lost: %v", panicked)
	}

	// Two waits, growing. The third failure exhausts the budget, so it is never followed by a
	// backoff — a supervisor that slept before giving up would delay shutdown for nothing.
	if want := []time.Duration{time.Second, 2 * time.Second}; !equalDurations(clock.recorded(), want) {
		t.Errorf("backoff delays were %v, want %v", clock.recorded(), want)
	}
}

func TestLoopReturningNilIsNotRestarted(t *testing.T) {
	clock := newFakeClock()
	sup := New(context.Background(), testConfig(clock))

	var calls counter
	sup.Go("one-shot", func(context.Context) error {
		calls.inc()
		return nil
	})

	if err := sup.Wait(); err != nil {
		t.Fatalf("Wait returned %v, want nil", err)
	}
	if got := calls.get(); got != 1 {
		t.Errorf("the loop ran %d times, want 1: returning nil means it finished on purpose", got)
	}
	if got := clock.recorded(); len(got) != 0 {
		t.Errorf("a clean finish should not back off, got %v", got)
	}
}

func TestTransientErrorIsRestartedUntilItSucceeds(t *testing.T) {
	clock := newFakeClock()
	sup := New(context.Background(), testConfig(clock))

	var calls counter
	sup.Go("uploader", func(context.Context) error {
		if calls.inc() < 3 {
			return errors.New("the network went away")
		}
		return nil
	})

	if err := sup.Wait(); err != nil {
		t.Fatalf("Wait returned %v, want nil: the loop recovered inside its budget", err)
	}
	if got := calls.get(); got != 3 {
		t.Errorf("the loop ran %d times, want 3", got)
	}
}

func TestBackoffGrowsAndIsCapped(t *testing.T) {
	clock := newFakeClock()
	cfg := testConfig(clock)
	cfg.MinBackoff = time.Second
	cfg.MaxBackoff = 4 * time.Second
	cfg.MaxFailures = 7
	sup := New(context.Background(), cfg)

	sup.Go("screenshotter", func(context.Context) error {
		return errors.New("display not available")
	})
	if err := sup.Wait(); !errors.Is(err, ErrGaveUp) {
		t.Fatalf("Wait returned %v, want ErrGaveUp", err)
	}

	want := []time.Duration{
		1 * time.Second,
		2 * time.Second,
		4 * time.Second,
		4 * time.Second, // capped
		4 * time.Second,
		4 * time.Second,
	}
	if got := clock.recorded(); !equalDurations(got, want) {
		t.Errorf("backoff delays were %v, want %v", got, want)
	}
}

func TestJitterStaysWithinItsFraction(t *testing.T) {
	clock := newFakeClock()
	cfg := testConfig(clock)
	cfg.Jitter = 0.25
	cfg.MinBackoff = time.Second
	cfg.MaxBackoff = time.Second

	// The extremes of Rand's range, which is where an off-by-one in the jitter arithmetic
	// would show up as a negative or doubled delay.
	for _, r := range []float64{0, 0.5, 0.999999} {
		cfg.Rand = func() float64 { return r }
		sup := New(context.Background(), cfg)

		got := sup.backoff(1)
		if got < 750*time.Millisecond || got > 1250*time.Millisecond {
			t.Errorf("with Rand()=%v the delay was %v, want it within 25%% of 1s", r, got)
		}
	}
}

func TestBackoffDoesNotOverflowAfterManyFailures(t *testing.T) {
	sup := New(context.Background(), testConfig(newFakeClock()))

	// 2^99 nanoseconds overflows an int64 several times over. The delay must still be the cap.
	if got := sup.backoff(100); got != time.Minute {
		t.Errorf("backoff(100) = %v, want the MaxBackoff of 1m", got)
	}
}

func TestFailureBudgetIsPerWindowNotForever(t *testing.T) {
	clock := newFakeClock()
	cfg := testConfig(clock)
	cfg.MaxFailures = 2
	cfg.FailureWindow = time.Minute
	cfg.MinBackoff = time.Second
	sup := New(context.Background(), cfg)

	// A loop that runs happily for longer than the window and then fails has recovered; its
	// backoff and its budget both start again. Four failures spread over hours must therefore
	// not abandon a loop whose budget is two failures per minute.
	var calls counter
	sup.Go("config-poller", func(context.Context) error {
		clock.advance(2 * time.Minute)
		if calls.inc() < 4 {
			return errors.New("config fetch failed")
		}
		return nil
	})

	if err := sup.Wait(); err != nil {
		t.Fatalf("Wait returned %v, want nil: no two failures fell inside one window", err)
	}
	if got := calls.get(); got != 4 {
		t.Errorf("the loop ran %d times, want 4", got)
	}
	for _, delay := range clock.recorded() {
		if delay != time.Second {
			t.Errorf("delays were %v, want every one at MinBackoff after a long clean run",
				clock.recorded())
			break
		}
	}
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

func TestStopCancelsARunningLoopAndWaitReturns(t *testing.T) {
	sup := New(context.Background(), testConfig(newFakeClock()))

	running := make(chan struct{})
	sup.Go("sampler", func(ctx context.Context) error {
		close(running)
		<-ctx.Done()
		return ctx.Err()
	})

	// Synchronised on a channel rather than a sleep: the loop is provably inside fn before
	// the cancellation, so the test asserts the cancellation path and not a race with startup.
	<-running
	sup.Stop()

	if err := sup.Wait(); err != nil {
		t.Fatalf("Wait returned %v, want nil: a context error during shutdown is not a failure", err)
	}
}

func TestCancellingTheParentContextStopsEverything(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	sup := New(ctx, testConfig(newFakeClock()))

	running := make(chan struct{})
	sup.Go("sampler", func(ctx context.Context) error {
		close(running)
		<-ctx.Done()
		return nil
	})

	<-running
	cancel()

	if err := sup.Wait(); err != nil {
		t.Fatalf("Wait returned %v, want nil", err)
	}
}

func TestShutdownDuringBackoffStopsRestarting(t *testing.T) {
	clock := newFakeClock()
	sup := New(context.Background(), testConfig(clock))

	// Cancel the moment the loop is in backoff. A supervisor that only checked the context at
	// the top of the loop would still run fn once more, which during shutdown means capturing
	// a sample after the agent was told to stop.
	clock.onWait = func(time.Duration) { sup.Stop() }

	var calls counter
	sup.Go("sampler", func(context.Context) error {
		calls.inc()
		return errors.New("transient")
	})

	if err := sup.Wait(); err != nil {
		t.Fatalf("Wait returned %v, want nil", err)
	}
	if got := calls.get(); got != 1 {
		t.Errorf("the loop ran %d times, want 1: shutdown interrupted the backoff", got)
	}
}

func TestGoAfterShutdownNeverRunsTheFunction(t *testing.T) {
	sup := New(context.Background(), testConfig(newFakeClock()))
	sup.Stop()

	var calls counter
	sup.Go("late", func(context.Context) error {
		calls.inc()
		return nil
	})

	if err := sup.Wait(); err != nil {
		t.Fatalf("Wait returned %v, want nil", err)
	}
	if got := calls.get(); got != 0 {
		t.Errorf("the loop ran %d times after shutdown, want 0", got)
	}
}

func TestOneAbandonedLoopDoesNotStopTheOthers(t *testing.T) {
	clock := newFakeClock()
	sup := New(context.Background(), testConfig(clock))

	// The whole reason this package exists: a screenshotter that cannot work must not take
	// activity sampling with it.
	//
	// attempts is buffered and read exactly MaxFailures times, so the test knows the
	// screenshotter has exhausted its budget without waiting for anything.
	attempts := make(chan struct{}, 8)
	sup.Go("screenshotter", func(context.Context) error {
		attempts <- struct{}{}
		panic("no display")
	})

	sampling := make(chan struct{})
	release := make(chan struct{})
	var samples counter
	sup.Go("sampler", func(ctx context.Context) error {
		samples.inc()
		close(sampling)
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})

	<-sampling
	for i := 0; i < 3; i++ { // MaxFailures
		<-attempts
	}

	// The sampler is still inside its single run: it was neither restarted nor stopped by the
	// other loop's failure.
	if got := samples.get(); got != 1 {
		t.Errorf("the sampler ran %d times, want 1 uninterrupted run", got)
	}

	// Released rather than cancelled, so the abandonment is observed on its own terms: a
	// cancelled supervisor treats every outstanding failure as shutdown, which is right in
	// production and would hide the thing under test here.
	close(release)
	err := sup.Wait()

	var gaveUp *GaveUpError
	if !errors.As(err, &gaveUp) || gaveUp.Name != "screenshotter" {
		t.Errorf("Wait reported %v, want an abandonment of the screenshotter alone", err)
	}
}

// ---------------------------------------------------------------------------
// What reaches the log
// ---------------------------------------------------------------------------

// panickingProbe exists so its name appears in the captured stack. An anonymous function would
// be logged as `func1`, which would let a test pass while proving nothing about whether the
// stack names the code that actually failed.
func panickingProbe() {
	panic("window title read failed")
}

func TestPanicStackReachesTheLog(t *testing.T) {
	var out bytes.Buffer
	clock := newFakeClock()
	cfg := testConfig(clock)
	cfg.MaxFailures = 1
	cfg.Logger = bufferLogger(t, &out)
	sup := New(context.Background(), cfg)

	sup.Go("sampler", func(context.Context) error {
		panickingProbe()
		return nil
	})
	if err := sup.Wait(); !errors.Is(err, ErrGaveUp) {
		t.Fatalf("Wait returned %v, want ErrGaveUp", err)
	}

	logged := out.String()
	for _, want := range []string{
		"supervised loop panicked",
		"window title read failed",
		"panickingProbe",
		`"loop":"sampler"`,
	} {
		if !strings.Contains(logged, want) {
			t.Errorf("the log is missing %q:\n%s", want, logged)
		}
	}
	if !strings.Contains(logged, "abandoned") {
		t.Errorf("the abandonment should be logged at error level:\n%s", logged)
	}
}

func TestPanicValueIsNotUsedAsAWindowTitleCarrier(t *testing.T) {
	// A panic value is logged through the same redaction as everything else, so a loop that
	// panics with a credential in the message cannot use the stack as a side channel.
	const secret = "sk-live-0123456789abcdef0123456789abcdef"

	var out bytes.Buffer
	logger := bufferLogger(t, &out)
	logger.AddSecret(secret)

	clock := newFakeClock()
	cfg := testConfig(clock)
	cfg.MaxFailures = 1
	cfg.Logger = logger
	sup := New(context.Background(), cfg)

	sup.Go("uploader", func(context.Context) error {
		panic("signing failed for " + secret)
	})
	_ = sup.Wait()

	if strings.Contains(out.String(), secret) {
		t.Errorf("a panic message carried a secret into the log:\n%s", out.String())
	}
}

func TestNilLoggerIsUsable(t *testing.T) {
	// main may well construct a supervisor before the logger is ready. That must not panic.
	sup := New(context.Background(), Config{Clock: newFakeClock(), MaxFailures: 1})
	sup.Go("probe", func(context.Context) error { panic("boom") })
	if err := sup.Wait(); !errors.Is(err, ErrGaveUp) {
		t.Fatalf("Wait returned %v, want ErrGaveUp", err)
	}
}

func TestSystemClockHonoursCancellation(t *testing.T) {
	// The one place a real clock is exercised. It uses a cancelled context rather than a
	// duration, so it completes immediately and cannot flake.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if err := (SystemClock{}).Wait(ctx, time.Hour); !errors.Is(err, context.Canceled) {
		t.Errorf("Wait returned %v, want context.Canceled", err)
	}
	if err := (SystemClock{}).Wait(ctx, 0); !errors.Is(err, context.Canceled) {
		t.Errorf("a zero delay must still observe cancellation, got %v", err)
	}
	if err := (SystemClock{}).Wait(context.Background(), 0); err != nil {
		t.Errorf("a zero delay on a live context returned %v, want nil", err)
	}
	if (SystemClock{}).Now().IsZero() {
		t.Error("SystemClock.Now returned the zero time")
	}
}

func equalDurations(got, want []time.Duration) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}
