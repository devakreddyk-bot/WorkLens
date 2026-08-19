// Package notice is the first-run transparency gate: the notice the employee reads, and the
// record that they read it.
//
// This is a hard product constraint rather than a piece of user interface. docs/PLAN.md §5 puts
// it in the startup order — config, notice, tray, capture — and calls that order a privacy
// control, because it is the difference between a monitoring tool and a covert one. Until
// Acknowledge has recorded an acknowledgment, no capture goroutine may be started. Nothing in
// this package can be configured to skip that, and the outcome type is arranged so that the zero
// value means "do not capture": every error path therefore fails closed, without anyone having
// to remember to check.
//
// # There is a second gate on the server
//
// `withAcknowledgedNotice` in backend/src/middleware/deviceAuth.ts rejects activity from a
// device with no recorded acknowledgment. That is not redundancy for its own sake: this gate can
// be removed by anyone willing to build the agent from patched source, and the server's cannot.
// The two together mean an employee's activity is only ever accepted if that employee was told,
// on their own screen, what would be collected.
//
// Which is why acknowledging writes two things — a local meta key, so the notice is not shown
// again, and a notice_ack event, so the fact reaches the server as evidence.
package notice

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/worklens/worklens/agent/internal/logging"
	"github.com/worklens/worklens/agent/internal/store"
)

// Store is the part of *store.Store this package needs.
//
// Narrowed to three methods so the gate's tests can drive it without a SQLite file, and so it is
// obvious from the interface alone that acknowledging touches exactly one meta key and appends
// exactly one event. *store.Store satisfies it as-is.
type Store interface {
	GetMeta(ctx context.Context, key string) (string, bool, error)
	SetMeta(ctx context.Context, key, value string) error
	AppendEvent(ctx context.Context, event store.Event) (string, error)
}

// Presenter shows the notice and reports whether the employee accepted it.
//
// It is an interface for one reason: the gate's logic — when the notice is shown, what happens
// when it is declined, that it is never shown twice — is the part that must be right, and none of
// it should need a desktop session to test. NewPresenter returns the real one for this OS.
type Presenter interface {
	// Present displays text and blocks until the employee answers. accepted is true only if
	// they explicitly agreed; a closed window, a timeout, or any error must not be reported as
	// agreement.
	Present(text string) (accepted bool, err error)
}

// PresenterFunc adapts a function to Presenter, for tests and for a caller that wants to route
// the notice somewhere else (a console prompt during enrolment, for instance).
type PresenterFunc func(text string) (bool, error)

// Present calls f.
func (f PresenterFunc) Present(text string) (bool, error) { return f(text) }

// timeLayout is how the acknowledgment instant is stored. The same layout internal/store uses
// for its own columns, so a person reading the meta table sees one format throughout.
const timeLayout = time.RFC3339Nano

// Acknowledged reports whether this device has already recorded an acknowledgment.
//
// It tests for the presence of store.MetaNoticeAcknowledgedAt and does not parse it. An
// unreadable timestamp is a bug in a timestamp; it is not evidence that the employee was never
// informed, and treating it as such would show the notice again on every start-up — which
// teaches people to dismiss it. Use AcknowledgedAt when the instant itself matters.
func Acknowledged(ctx context.Context, s Store) (bool, error) {
	value, present, err := s.GetMeta(ctx, store.MetaNoticeAcknowledgedAt)
	if err != nil {
		return false, fmt.Errorf("notice: could not read the acknowledgment: %w", err)
	}
	return present && value != "", nil
}

// AcknowledgedAt returns when the notice was acknowledged.
//
// The bool reports whether an acknowledgment is recorded at all. A non-nil error with present
// true means the stored value could not be parsed — the acknowledgment stands, but its instant
// is unusable, which `agentctl doctor` should show rather than hide.
func AcknowledgedAt(ctx context.Context, s Store) (time.Time, bool, error) {
	value, present, err := s.GetMeta(ctx, store.MetaNoticeAcknowledgedAt)
	if err != nil {
		return time.Time{}, false, fmt.Errorf("notice: could not read the acknowledgment: %w", err)
	}
	if !present || value == "" {
		return time.Time{}, false, nil
	}

	at, parseErr := time.Parse(timeLayout, value)
	if parseErr != nil {
		return time.Time{}, true, fmt.Errorf(
			"notice: the recorded acknowledgment time %q is not a timestamp: %w", value, parseErr)
	}
	return at, true, nil
}

// Acknowledge records that the employee acknowledged the notice at the instant at.
//
// It returns the acknowledgment's instant, which is the *first* one: calling it again is a no-op
// that moves nothing and appends nothing. That matters because the acknowledgment is evidence.
// A timestamp that crept forward every time the agent restarted would evidence nothing, and a
// second notice_ack event would claim the employee was asked twice when they were asked once.
//
// The event is appended before the meta key is written, and the order is deliberate. Crashing
// between the two shows the notice again on the next start — which is honest, and safe — whereas
// the opposite order would leave a device that believes it is acknowledged and a server that
// never heard, and the server's own gate would then reject that employee's activity for good.
func Acknowledge(ctx context.Context, s Store, at time.Time) (time.Time, error) {
	if at.IsZero() {
		return time.Time{}, errors.New("notice: an acknowledgment needs the instant it happened")
	}

	if existing, present, err := AcknowledgedAt(ctx, s); present {
		// A stored value that will not parse is left exactly as it is: rewriting it would
		// replace the moment the employee actually acknowledged with the moment we noticed the
		// problem, which is worse than an unreadable one.
		if err != nil {
			return time.Time{}, err
		}
		return existing, nil
	} else if err != nil {
		return time.Time{}, err
	}

	// No attribution, no duration, no detail. The notice's own text is deliberately not
	// carried: it is not evidence the server could trust anyway (the agent chose what to
	// send), the server records its own acknowledgment through POST /v1/device/notice-ack, and
	// a copy of the notice in every buffer would be bytes the ingest schema has no field for.
	event := store.Event{
		Type:       store.EventNoticeAck,
		CapturedAt: at.UTC(),
	}
	if _, err := s.AppendEvent(ctx, event); err != nil {
		return time.Time{}, fmt.Errorf("notice: could not queue the acknowledgment for upload: %w", err)
	}

	if err := s.SetMeta(ctx, store.MetaNoticeAcknowledgedAt, at.UTC().Format(timeLayout)); err != nil {
		return time.Time{}, fmt.Errorf("notice: could not record the acknowledgment: %w", err)
	}

	return at.UTC(), nil
}

// Outcome is what the gate decided.
//
// The zero value is OutcomeNotAcknowledged, and MayCapture is false for it. That is the whole
// design: a caller that ignores an error, or a future code path that returns early, cannot
// accidentally produce an outcome that permits capture.
type Outcome int

// The possible outcomes.
const (
	// OutcomeNotAcknowledged means capture must not start. It covers a failure to present the
	// notice and a failure to record an acceptance, as well as the zero value.
	OutcomeNotAcknowledged Outcome = iota

	// OutcomeDeclined means the employee read the notice and said no.
	OutcomeDeclined

	// OutcomeAcknowledged means the employee accepted it just now, and it has been recorded
	// and queued for upload.
	OutcomeAcknowledged

	// OutcomeAlreadyAcknowledged means an acknowledgment was already on record, so the notice
	// was not shown again.
	OutcomeAlreadyAcknowledged
)

// MayCapture reports whether capture goroutines may be started.
func (o Outcome) MayCapture() bool {
	return o == OutcomeAcknowledged || o == OutcomeAlreadyAcknowledged
}

// String names the outcome for logs and for `agentctl status`.
func (o Outcome) String() string {
	switch o {
	case OutcomeDeclined:
		return "declined"
	case OutcomeAcknowledged:
		return "acknowledged"
	case OutcomeAlreadyAcknowledged:
		return "already acknowledged"
	default:
		return "not acknowledged"
	}
}

// Gate decides whether capture may begin, showing the notice if it has to.
type Gate struct {
	// Store is where the acknowledgment is recorded. Required.
	Store Store

	// Presenter shows the notice. Required — see Ensure.
	Presenter Presenter

	// Details fills in the parts of the notice that depend on this installation.
	Details Details

	// Now is injected for tests. Nil means time.Now.
	Now func() time.Time

	// Log receives the outcome. Nil discards. The notice's text is never logged: it is two
	// kilobytes of constant prose, and a log file is not where anyone should read it.
	Log *logging.Logger
}

// Ensure returns the outcome of the notice gate, showing the notice if no acknowledgment is on
// record yet.
//
// A missing Presenter is an error rather than a default. The tempting default — "no way to ask,
// so carry on" — is precisely the behaviour the product promises not to have, and it would be a
// one-line change made by someone who did not know that.
func (g Gate) Ensure(ctx context.Context) (Outcome, error) {
	log := logging.OrDiscard(g.Log)

	if g.Store == nil {
		return OutcomeNotAcknowledged, errors.New("notice: the gate needs a store to record into")
	}

	acknowledged, err := Acknowledged(ctx, g.Store)
	if err != nil {
		return OutcomeNotAcknowledged, err
	}
	if acknowledged {
		if at, _, atErr := AcknowledgedAt(ctx, g.Store); atErr != nil {
			log.Warn("the recorded notice acknowledgment has an unreadable timestamp",
				logging.Err(atErr))
		} else {
			log.Debug("the monitoring notice was acknowledged previously",
				logging.Time("acknowledged_at", at))
		}
		return OutcomeAlreadyAcknowledged, nil
	}

	if g.Presenter == nil {
		return OutcomeNotAcknowledged, errors.New(
			"notice: no way to show the notice, so capture must not start")
	}

	log.Info("showing the first-run monitoring notice; capture will not start until it is acknowledged")

	accepted, err := g.Presenter.Present(Text(g.Details))
	if err != nil {
		return OutcomeNotAcknowledged, fmt.Errorf("notice: could not show the notice: %w", err)
	}
	if !accepted {
		log.Warn("the monitoring notice was declined; nothing will be recorded")
		return OutcomeDeclined, nil
	}

	now := time.Now
	if g.Now != nil {
		now = g.Now
	}

	at, err := Acknowledge(ctx, g.Store, now())
	if err != nil {
		// Accepted but unrecorded. Capture still must not start: the server would reject the
		// data anyway, and recording activity we cannot show was consented to is the exact
		// thing this gate exists to prevent.
		return OutcomeNotAcknowledged, err
	}

	log.Info("the monitoring notice was acknowledged", logging.Time("acknowledged_at", at))
	return OutcomeAcknowledged, nil
}
