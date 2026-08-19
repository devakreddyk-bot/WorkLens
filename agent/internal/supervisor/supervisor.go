// Package supervisor keeps the agent's long-running loops running.
//
// The agent is four or five goroutines that never return: the sampler, the screenshotter, the
// uploader, the config poller. Started with a bare `go`, any one of them panicking takes the
// whole process down — and the process is a monitoring agent, so "it died at 09:12 and nobody
// noticed until payroll" is a real outcome. Worse, an unrecovered panic in the screenshot loop
// would stop the sampler too, turning a cosmetic failure into a day of missing timesheet data.
//
// So each loop runs under a supervisor that recovers panics, logs them with the loop's name and
// the stack, and restarts the loop with exponential backoff and jitter.
//
// # Why restarts are budgeted
//
// A loop that fails on its first instruction every time — a missing DLL, a corrupt database, a
// revoked permission — must not be restarted forever. Spinning on it burns battery, fills the
// log with the same stack, and makes the real problem harder to find, all while pretending to
// recover. After MaxFailures failures within FailureWindow the supervisor gives up on that loop,
// records that it has, and lets the rest of the agent carry on: a broken screenshotter should
// not stop time being recorded, and the tray can then show that something is wrong.
//
// # Why the clock is injected
//
// Backoff means waiting, and a test that waits is a test that flakes on a loaded CI runner.
// Clock is an interface; tests supply one whose Wait returns immediately and records what it was
// asked to wait for, so the entire restart policy — growth, the cap, jitter, the budget — is
// asserted exactly and in microseconds. Nothing in this package calls time.Sleep.
package supervisor

import (
	"context"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"runtime"
	"sync"
	"time"

	"github.com/worklens/worklens/agent/internal/logging"
)

// Clock is the supervisor's view of time. See the package documentation for why it exists.
type Clock interface {
	// Now reports the current instant. Used only to age out failures from the budget window.
	Now() time.Time

	// Wait blocks for d or until ctx is done, returning ctx.Err() if the context ended
	// first. Returning the context error rather than a bool is what makes the caller's
	// cancellation handling a single `if err != nil`.
	Wait(ctx context.Context, d time.Duration) error
}

// SystemClock is the production Clock.
type SystemClock struct{}

// Now returns time.Now.
func (SystemClock) Now() time.Time { return time.Now() }

// Wait sleeps for d unless ctx ends first.
//
// The timer is stopped on every path: a supervisor with several loops in backoff during
// shutdown would otherwise leave one runtime timer per loop pending until it fired.
func (SystemClock) Wait(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		// Still honour cancellation: a zero delay must not be a way to skip the check.
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
			return nil
		}
	}

	timer := time.NewTimer(d)
	defer timer.Stop()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// Defaults. The backoff range matches the uploader's (docs/PLAN.md §5): a loop that fails
// transiently is back within a second, and one that keeps failing settles at five minutes
// rather than hammering whatever it depends on. Five failures in ten minutes is the budget —
// enough to ride out a laptop resuming from sleep, few enough that a permanent fault is
// declared while the log still fits on one screen.
const (
	DefaultMinBackoff    = time.Second
	DefaultMaxBackoff    = 5 * time.Minute
	DefaultMaxFailures   = 5
	DefaultFailureWindow = 10 * time.Minute
	DefaultJitter        = 0.25
)

// Config configures a Supervisor. The zero Config is valid and uses the defaults above.
type Config struct {
	// MinBackoff is the delay after the first failure.
	MinBackoff time.Duration

	// MaxBackoff caps the delay however many times a loop has failed.
	MaxBackoff time.Duration

	// Jitter spreads each delay by up to this fraction either side, in [0, 1). Jitter is not
	// decoration: several loops that all fail on the same lost network would otherwise
	// retry in lockstep forever, and the agent would produce a burst of identical failures
	// every backoff interval instead of a spread of individual ones.
	Jitter float64

	// MaxFailures is how many failures within FailureWindow are tolerated before the
	// supervisor gives up on a loop. Must be at least 1.
	MaxFailures int

	// FailureWindow is the span over which failures are counted. It is also the run time
	// after which a loop is considered to have recovered: a loop that ran happily for longer
	// than this and then failed starts again from MinBackoff rather than from wherever its
	// backoff had climbed to hours earlier.
	FailureWindow time.Duration

	// Clock is injected by tests. Nil means SystemClock.
	Clock Clock

	// Rand returns a value in [0, 1) for the jitter calculation. Nil means a
	// package-internal, mutex-protected source. Tests pin it to make delays exact.
	Rand func() float64

	// Logger receives one line per failure and one per abandonment. Nil means discard,
	// which is the wrong choice in production and a convenient one in tests.
	Logger *logging.Logger
}

func (c Config) withDefaults() Config {
	if c.MinBackoff <= 0 {
		c.MinBackoff = DefaultMinBackoff
	}
	if c.MaxBackoff < c.MinBackoff {
		c.MaxBackoff = maxDuration(DefaultMaxBackoff, c.MinBackoff)
	}
	if c.Jitter < 0 || c.Jitter >= 1 {
		c.Jitter = DefaultJitter
	}
	if c.MaxFailures <= 0 {
		c.MaxFailures = DefaultMaxFailures
	}
	if c.FailureWindow <= 0 {
		c.FailureWindow = DefaultFailureWindow
	}
	if c.Clock == nil {
		c.Clock = SystemClock{}
	}
	if c.Rand == nil {
		source := rand.New(rand.NewSource(time.Now().UnixNano()))
		var mu sync.Mutex
		c.Rand = func() float64 {
			mu.Lock()
			defer mu.Unlock()
			return source.Float64()
		}
	}
	return c
}

func maxDuration(a, b time.Duration) time.Duration {
	if a > b {
		return a
	}
	return b
}

// PanicError is the error a recovered panic becomes.
//
// It carries the stack captured at the moment of the panic, not at the moment of the recover:
// by the time the deferred function runs, the frames that matter are still on the stack, and
// capturing there is the only way the log names the line that actually failed. Without this the
// agent's log would say "the sampler panicked" and nothing more, which is not enough to fix
// anything.
type PanicError struct {
	// Value is whatever was passed to panic.
	Value any
	// Stack is the goroutine's stack at the point of the panic.
	Stack []byte
}

// Error renders the panic value. The stack is deliberately not part of the message: it is
// logged as its own field, so that a log aggregator groups on the message rather than treating
// every occurrence as unique.
func (e *PanicError) Error() string {
	return fmt.Sprintf("panic: %v", e.Value)
}

// ErrGaveUp wraps the last failure of a loop the supervisor has stopped restarting. Callers
// match on it to tell "this loop exhausted its budget" apart from an ordinary error.
var ErrGaveUp = errors.New("supervisor: gave up restarting")

// GaveUpError reports that a loop exceeded its failure budget.
type GaveUpError struct {
	// Name is the loop's name, as passed to Go.
	Name string
	// Failures is how many failures were counted inside the window.
	Failures int
	// Window is the window they were counted over.
	Window time.Duration
	// Last is the failure that exhausted the budget.
	Last error
}

// Error describes the abandonment in the terms an operator needs: which loop, how often, and
// over what period.
func (e *GaveUpError) Error() string {
	return fmt.Sprintf("supervisor: gave up restarting %q after %d failures within %s: %v",
		e.Name, e.Failures, e.Window, e.Last)
}

// Unwrap exposes both the sentinel and the underlying failure, so errors.Is works for
// ErrGaveUp and for whatever actually went wrong.
func (e *GaveUpError) Unwrap() []error { return []error{ErrGaveUp, e.Last} }

// Supervisor runs supervised loops. Create one with New, add loops with Go, and call Wait.
type Supervisor struct {
	cfg    Config
	log    *logging.Logger
	ctx    context.Context
	cancel context.CancelFunc

	wg sync.WaitGroup

	mu       sync.Mutex
	failures []error
}

// New returns a Supervisor whose loops all run under a context derived from parent.
//
// Cancelling parent — or calling Stop — stops every loop. There is no way to run a supervised
// loop outside that context, which is what makes shutdown a single operation rather than a list
// of channels somebody has to remember to close.
func New(parent context.Context, cfg Config) *Supervisor {
	cfg = cfg.withDefaults()
	ctx, cancel := context.WithCancel(parent)
	return &Supervisor{
		cfg:    cfg,
		log:    logging.OrDiscard(cfg.Logger),
		ctx:    ctx,
		cancel: cancel,
	}
}

// Context returns the supervisor's context. Loops that need to start a child operation after
// Go has returned — a one-off upload on shutdown, say — should derive it from this so it is
// cancelled with everything else.
func (s *Supervisor) Context() context.Context { return s.ctx }

// Go starts fn under supervision, named for the logs.
//
// fn is expected to run until its context is cancelled. Its outcomes:
//
//   - returns nil: the loop finished on purpose and is NOT restarted. A capture loop returning
//     nil means it decided its work was done, and second-guessing that would produce a loop
//     nobody can shut down.
//   - returns a context error while the supervisor is shutting down: treated as a clean stop.
//   - returns any other error: a failure. Logged, counted against the budget, restarted after
//     backoff.
//   - panics: recovered, logged with the stack, and treated as a failure.
//
// Go returns immediately. Call Wait to block until every loop has stopped.
func (s *Supervisor) Go(name string, fn func(context.Context) error) {
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.supervise(name, fn)
	}()
}

// Stop cancels every loop. It does not wait; follow it with Wait.
func (s *Supervisor) Stop() { s.cancel() }

// Wait blocks until every supervised loop has stopped, then returns the abandonments.
//
// A nil return means every loop either finished on purpose or was still running when the
// context was cancelled. A non-nil return means at least one loop exhausted its failure budget,
// and each joined error is a *GaveUpError naming it — which is what `main` reports and what
// makes the agent's exit status honest about having run degraded.
func (s *Supervisor) Wait() error {
	s.wg.Wait()

	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.failures) == 0 {
		return nil
	}
	return errors.Join(s.failures...)
}

// supervise is the restart loop for one named function.
func (s *Supervisor) supervise(name string, fn func(context.Context) error) {
	log := s.log.With(logging.String("loop", name))

	// consecutive drives the backoff; window holds the failure timestamps the budget counts.
	consecutive := 0
	window := make([]time.Time, 0, s.cfg.MaxFailures)

	for {
		if s.ctx.Err() != nil {
			return
		}

		startedAt := s.cfg.Clock.Now()
		err := runOnce(s.ctx, fn)
		ranFor := s.cfg.Clock.Now().Sub(startedAt)

		if err == nil {
			log.Info("supervised loop finished", logging.Duration("ran_for", ranFor))
			return
		}

		// Cancellation is not a failure. A loop that returns ctx.Err() on shutdown is doing
		// exactly what it was asked to; counting that against its budget would mean a laptop
		// suspended five times in ten minutes came back with its loops abandoned.
		if s.ctx.Err() != nil {
			log.Debug("supervised loop stopped for shutdown",
				logging.Duration("ran_for", ranFor), logging.Err(err))
			return
		}

		var panicked *PanicError
		if errors.As(err, &panicked) {
			log.Error("supervised loop panicked and will be restarted",
				logging.Duration("ran_for", ranFor),
				logging.Any("panic", fmt.Sprint(panicked.Value)),
				logging.String("stack", string(panicked.Stack)))
		} else {
			log.Warn("supervised loop failed and will be restarted",
				logging.Duration("ran_for", ranFor), logging.Err(err))
		}

		now := s.cfg.Clock.Now()

		// A loop that stayed up longer than the window has demonstrably recovered, so its
		// backoff starts again from the bottom. Without this, a loop that fails once a day
		// would eventually be waiting five minutes before each restart for no reason.
		if ranFor >= s.cfg.FailureWindow {
			consecutive = 0
			window = window[:0]
		}

		consecutive++
		window = append(window, now)
		window = pruneOlderThan(window, now.Add(-s.cfg.FailureWindow))

		if len(window) >= s.cfg.MaxFailures {
			gaveUp := &GaveUpError{
				Name:     name,
				Failures: len(window),
				Window:   s.cfg.FailureWindow,
				Last:     err,
			}
			log.Error("supervised loop abandoned: it has failed too often to be worth restarting",
				logging.Int("failures", len(window)),
				logging.Duration("window", s.cfg.FailureWindow),
				logging.Err(err))
			s.record(gaveUp)
			return
		}

		delay := s.backoff(consecutive)
		log.Info("restarting supervised loop after backoff",
			logging.Duration("delay", delay),
			logging.Int("failures_in_window", len(window)))

		if waitErr := s.cfg.Clock.Wait(s.ctx, delay); waitErr != nil {
			log.Debug("shutdown interrupted a restart backoff")
			return
		}
	}
}

// runOnce calls fn and converts a panic into a *PanicError.
//
// The recover has to happen here, one frame away from the call, rather than in supervise: a
// deferred recover in the restart loop would also swallow a panic in the supervisor's own
// bookkeeping, which is a bug we want to hear about loudly rather than absorb quietly.
func runOnce(ctx context.Context, fn func(context.Context) error) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			// false: this goroutine's stack only. The other goroutines' stacks would be
			// megabytes of noise in a file with a size cap.
			buf := make([]byte, 64<<10)
			buf = buf[:runtime.Stack(buf, false)]
			err = &PanicError{Value: recovered, Stack: buf}
		}
	}()
	return fn(ctx)
}

func pruneOlderThan(times []time.Time, cutoff time.Time) []time.Time {
	kept := times[:0]
	for _, at := range times {
		if at.After(cutoff) {
			kept = append(kept, at)
		}
	}
	return kept
}

func (s *Supervisor) record(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failures = append(s.failures, err)
}

// backoff returns the delay before the nth consecutive restart (n starting at 1).
//
// Doubling from MinBackoff, capped at MaxBackoff, then spread by Jitter. The shift is computed
// in float64 rather than as `Min << (n-1)` because a loop that has failed 70 times would
// overflow the shift and produce a negative duration — a "restart immediately, forever" bug
// that only appears after an agent has been broken for a long time, which is the worst moment
// to discover it.
func (s *Supervisor) backoff(consecutive int) time.Duration {
	if consecutive < 1 {
		consecutive = 1
	}

	grown := float64(s.cfg.MinBackoff) * math.Pow(2, float64(consecutive-1))
	if grown > float64(s.cfg.MaxBackoff) || math.IsInf(grown, 0) {
		grown = float64(s.cfg.MaxBackoff)
	}

	if s.cfg.Jitter > 0 {
		// Rand() in [0, 1) maps to a multiplier in [1-Jitter, 1+Jitter).
		grown *= 1 + s.cfg.Jitter*(2*s.cfg.Rand()-1)
	}
	if grown < 0 {
		grown = 0
	}
	return time.Duration(grown)
}
