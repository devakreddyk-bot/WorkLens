package notice

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/worklens/worklens/agent/internal/store"
)

// The gate is the one piece of the agent whose failure mode is a legal and ethical problem rather
// than a technical one, so these tests are about the decision and not the window: shown once,
// never again, declining works, and nothing is recorded unless it was accepted and stored.

var acknowledgedAt = time.Date(2026, 3, 17, 8, 55, 12, 0, time.UTC)

// fakeStore is the three-method Store, with hooks for the failure paths.
type fakeStore struct {
	mu     sync.Mutex
	meta   map[string]string
	events []store.Event

	getErr    error
	setErr    error
	appendErr error
}

func newFakeStore() *fakeStore {
	return &fakeStore{meta: map[string]string{}}
}

func (f *fakeStore) GetMeta(_ context.Context, key string) (string, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.getErr != nil {
		return "", false, f.getErr
	}
	value, present := f.meta[key]
	return value, present, nil
}

func (f *fakeStore) SetMeta(_ context.Context, key, value string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.setErr != nil {
		return f.setErr
	}
	f.meta[key] = value
	return nil
}

func (f *fakeStore) AppendEvent(_ context.Context, event store.Event) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.appendErr != nil {
		return "", f.appendErr
	}
	if err := event.Validate(); err != nil {
		// The real store validates, so the fake must too: an event the gate builds wrongly
		// should fail here rather than in production as a rejected upload batch.
		return "", err
	}
	event.ClientEventID = "fake-" + event.CapturedAt.Format(time.RFC3339Nano)
	f.events = append(f.events, event)
	return event.ClientEventID, nil
}

func (f *fakeStore) snapshot() (map[string]string, []store.Event) {
	f.mu.Lock()
	defer f.mu.Unlock()
	meta := make(map[string]string, len(f.meta))
	for k, v := range f.meta {
		meta[k] = v
	}
	return meta, append([]store.Event(nil), f.events...)
}

// fakePresenter counts how often it was asked and answers as instructed.
type fakePresenter struct {
	mu         sync.Mutex
	calls      int
	lastText   string
	accept     bool
	presentErr error
}

func (p *fakePresenter) Present(text string) (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls++
	p.lastText = text
	if p.presentErr != nil {
		return false, p.presentErr
	}
	return p.accept, nil
}

func (p *fakePresenter) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls
}

func testGate(s Store, p Presenter) Gate {
	return Gate{
		Store:     s,
		Presenter: p,
		Details: Details{
			OrgName:             "Northwind Joinery",
			ContactName:         "Dana Reyes",
			ContactEmail:        "privacy@example.invalid",
			DashboardURL:        "https://worklens.example.invalid",
			CaptureWindowTitles: true,
			WorkHoursOnly:       true,
			WorkHours:           "09:00-17:30, Monday to Friday",
			IdleThreshold:       5 * time.Minute,
		},
		Now: func() time.Time { return acknowledgedAt },
	}
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

func TestNotYetAcknowledgedPresentsTheNotice(t *testing.T) {
	s := newFakeStore()
	p := &fakePresenter{accept: true}

	outcome, err := testGate(s, p).Ensure(context.Background())
	if err != nil {
		t.Fatalf("Ensure returned %v", err)
	}
	if outcome != OutcomeAcknowledged {
		t.Errorf("outcome was %v, want acknowledged", outcome)
	}
	if !outcome.MayCapture() {
		t.Error("an acknowledged notice must permit capture")
	}
	if p.count() != 1 {
		t.Errorf("the notice was shown %d times, want 1", p.count())
	}
	if !strings.Contains(p.lastText, "Northwind Joinery") {
		t.Error("the presented text was not the configured notice")
	}
}

func TestAcceptedNoticeWritesMetaAndExactlyOneEvent(t *testing.T) {
	s := newFakeStore()

	outcome, err := testGate(s, &fakePresenter{accept: true}).Ensure(context.Background())
	if err != nil || outcome != OutcomeAcknowledged {
		t.Fatalf("Ensure = (%v, %v)", outcome, err)
	}

	meta, events := s.snapshot()
	if got := meta[store.MetaNoticeAcknowledgedAt]; got != acknowledgedAt.Format(time.RFC3339Nano) {
		t.Errorf("meta holds %q, want %q", got, acknowledgedAt.Format(time.RFC3339Nano))
	}
	if len(events) != 1 {
		t.Fatalf("appended %d events, want exactly 1", len(events))
	}

	event := events[0]
	if event.Type != store.EventNoticeAck {
		t.Errorf("event type was %q, want %q", event.Type, store.EventNoticeAck)
	}
	if !event.CapturedAt.Equal(acknowledgedAt) {
		t.Errorf("event captured_at was %v, want %v", event.CapturedAt, acknowledgedAt)
	}
	// The acknowledgment carries no attribution and no copy of the notice: it is the fact that
	// it happened, and nothing else.
	if event.AppName != "" || event.WindowTitle != "" || event.URLHost != "" || event.Detail != "" {
		t.Errorf("the acknowledgment event carries content it should not: %+v", event)
	}
	if event.Duration != 0 {
		t.Errorf("the acknowledgment has a duration of %v, want 0", event.Duration)
	}
}

func TestDecliningLeavesNothingRecorded(t *testing.T) {
	s := newFakeStore()
	p := &fakePresenter{accept: false}

	outcome, err := testGate(s, p).Ensure(context.Background())
	if err != nil {
		t.Fatalf("declining is not an error: %v", err)
	}
	if outcome != OutcomeDeclined {
		t.Errorf("outcome was %v, want declined", outcome)
	}
	if outcome.MayCapture() {
		t.Fatal("a declined notice must not permit capture")
	}

	meta, events := s.snapshot()
	if _, present := meta[store.MetaNoticeAcknowledgedAt]; present {
		t.Error("declining wrote an acknowledgment")
	}
	if len(events) != 0 {
		t.Errorf("declining appended %d events, want 0", len(events))
	}

	// And it stays declined: a second start-up asks again rather than assuming.
	if acknowledged, err := Acknowledged(context.Background(), s); err != nil || acknowledged {
		t.Errorf("Acknowledged = (%v, %v), want (false, nil)", acknowledged, err)
	}
}

func TestAlreadyAcknowledgedDoesNotPresentAgain(t *testing.T) {
	s := newFakeStore()
	s.meta[store.MetaNoticeAcknowledgedAt] = acknowledgedAt.Format(time.RFC3339Nano)
	p := &fakePresenter{accept: true}

	outcome, err := testGate(s, p).Ensure(context.Background())
	if err != nil {
		t.Fatalf("Ensure returned %v", err)
	}
	if outcome != OutcomeAlreadyAcknowledged {
		t.Errorf("outcome was %v, want already acknowledged", outcome)
	}
	if !outcome.MayCapture() {
		t.Error("a previously acknowledged notice must permit capture")
	}
	if p.count() != 0 {
		t.Errorf("the notice was shown %d times, want 0", p.count())
	}

	_, events := s.snapshot()
	if len(events) != 0 {
		t.Errorf("a restart appended %d acknowledgment events, want 0", len(events))
	}
}

func TestAcknowledgeIsIdempotent(t *testing.T) {
	s := newFakeStore()
	ctx := context.Background()

	first, err := Acknowledge(ctx, s, acknowledgedAt)
	if err != nil {
		t.Fatalf("first Acknowledge: %v", err)
	}

	later := acknowledgedAt.Add(72 * time.Hour)
	second, err := Acknowledge(ctx, s, later)
	if err != nil {
		t.Fatalf("second Acknowledge: %v", err)
	}

	if !second.Equal(first) {
		t.Errorf("the acknowledgment moved from %v to %v; it is evidence and must not drift",
			first, second)
	}

	_, events := s.snapshot()
	if len(events) != 1 {
		t.Errorf("acknowledging twice appended %d events, want 1", len(events))
	}
}

func TestAcknowledgeRejectsAZeroInstant(t *testing.T) {
	if _, err := Acknowledge(context.Background(), newFakeStore(), time.Time{}); err == nil {
		t.Error("Acknowledge accepted the zero time")
	}
}

func TestAFailureToRecordDoesNotPermitCapture(t *testing.T) {
	// The employee said yes and the store would not take it. Capture must still not start:
	// the server's own gate would reject the data, and recording activity whose consent we
	// cannot show is the thing this package exists to prevent.
	for name, breakStore := range map[string]func(*fakeStore){
		"append fails": func(f *fakeStore) { f.appendErr = errors.New("disk full") },
		"meta fails":   func(f *fakeStore) { f.setErr = errors.New("database is locked") },
		"read fails":   func(f *fakeStore) { f.getErr = errors.New("database is corrupt") },
	} {
		t.Run(name, func(t *testing.T) {
			s := newFakeStore()
			breakStore(s)

			outcome, err := testGate(s, &fakePresenter{accept: true}).Ensure(context.Background())
			if err == nil {
				t.Fatal("Ensure hid a storage failure")
			}
			if outcome != OutcomeNotAcknowledged {
				t.Errorf("outcome was %v, want not acknowledged", outcome)
			}
			if outcome.MayCapture() {
				t.Fatal("capture must not start when the acknowledgment could not be recorded")
			}
		})
	}
}

func TestAppendFailureLeavesNoAcknowledgment(t *testing.T) {
	// The event is appended before the meta key, so a failure there must leave the device
	// looking unacknowledged rather than acknowledged-but-never-reported.
	s := newFakeStore()
	s.appendErr = errors.New("disk full")

	if _, err := testGate(s, &fakePresenter{accept: true}).Ensure(context.Background()); err == nil {
		t.Fatal("expected an error")
	}

	meta, _ := s.snapshot()
	if _, present := meta[store.MetaNoticeAcknowledgedAt]; present {
		t.Error("the meta key was written even though the event was not queued")
	}
}

func TestPresenterErrorIsNotAgreement(t *testing.T) {
	s := newFakeStore()
	p := &fakePresenter{accept: true, presentErr: ErrUnsupportedForTest()}

	outcome, err := testGate(s, p).Ensure(context.Background())
	if err == nil {
		t.Fatal("a presenter failure should be reported")
	}
	if outcome.MayCapture() {
		t.Fatal("a notice that could not be shown must not permit capture")
	}

	meta, events := s.snapshot()
	if len(meta) != 0 || len(events) != 0 {
		t.Error("a presenter failure recorded an acknowledgment")
	}
}

// ErrUnsupportedForTest returns a stand-in for whatever the platform's presenter fails with, so
// this test file compiles on Windows (where ErrUnsupported does not exist) as well as elsewhere.
func ErrUnsupportedForTest() error { return errors.New("no interactive desktop") }

func TestNoPresenterIsAnErrorNotADefault(t *testing.T) {
	outcome, err := Gate{Store: newFakeStore()}.Ensure(context.Background())
	if err == nil {
		t.Fatal("a gate with no way to ask must report that, not carry on")
	}
	if outcome.MayCapture() {
		t.Fatal("capture must not start when the notice cannot be shown")
	}
}

func TestNoStoreIsAnError(t *testing.T) {
	if _, err := (Gate{Presenter: &fakePresenter{accept: true}}).Ensure(context.Background()); err == nil {
		t.Error("a gate with nowhere to record must report that")
	}
}

func TestZeroOutcomeDoesNotPermitCapture(t *testing.T) {
	// The property the whole package leans on: a forgotten branch returns the zero value, and
	// the zero value cannot start capture.
	var outcome Outcome
	if outcome.MayCapture() {
		t.Fatal("the zero Outcome must not permit capture")
	}
	if outcome.String() != "not acknowledged" {
		t.Errorf("the zero Outcome reads as %q", outcome.String())
	}
}

func TestUnreadableTimestampStillCountsAsAcknowledged(t *testing.T) {
	s := newFakeStore()
	s.meta[store.MetaNoticeAcknowledgedAt] = "sometime last Tuesday"
	p := &fakePresenter{accept: true}

	outcome, err := testGate(s, p).Ensure(context.Background())
	if err != nil {
		t.Fatalf("Ensure returned %v", err)
	}
	if outcome != OutcomeAlreadyAcknowledged {
		t.Errorf("outcome was %v; a corrupt timestamp is not evidence that nobody was told", outcome)
	}
	if p.count() != 0 {
		t.Error("the notice was shown again because of an unparseable timestamp")
	}

	if _, present, err := AcknowledgedAt(context.Background(), s); err == nil || !present {
		t.Error("AcknowledgedAt should report the value as present and unreadable")
	}

	// And it is left alone rather than rewritten with today's date.
	if _, err := Acknowledge(context.Background(), s, acknowledgedAt); err == nil {
		t.Error("Acknowledge should refuse to overwrite an unreadable acknowledgment")
	}
	meta, _ := s.snapshot()
	if meta[store.MetaNoticeAcknowledgedAt] != "sometime last Tuesday" {
		t.Error("the stored acknowledgment was overwritten")
	}
}

func TestAcknowledgedAtRoundTrips(t *testing.T) {
	s := newFakeStore()
	ctx := context.Background()

	if at, present, err := AcknowledgedAt(ctx, s); present || err != nil || !at.IsZero() {
		t.Errorf("AcknowledgedAt on a fresh store = (%v, %v, %v)", at, present, err)
	}

	if _, err := Acknowledge(ctx, s, acknowledgedAt); err != nil {
		t.Fatalf("Acknowledge: %v", err)
	}

	at, present, err := AcknowledgedAt(ctx, s)
	if err != nil || !present {
		t.Fatalf("AcknowledgedAt = (%v, %v, %v)", at, present, err)
	}
	if !at.Equal(acknowledgedAt) {
		t.Errorf("AcknowledgedAt = %v, want %v", at, acknowledgedAt)
	}
}

// ---------------------------------------------------------------------------
// Against the real store
// ---------------------------------------------------------------------------

func TestGateAgainstTheRealStore(t *testing.T) {
	// Proves two things the fake cannot: that *store.Store satisfies this package's Store
	// interface, and that the notice_ack event it builds survives the store's own validation
	// and the round trip through SQLite.
	buffer, err := store.Open(filepath.Join(t.TempDir(), "buffer.db"), store.Options{})
	if err != nil {
		t.Fatalf("opening the buffer: %v", err)
	}
	t.Cleanup(func() { _ = buffer.Close() })

	ctx := context.Background()
	gate := testGate(buffer, &fakePresenter{accept: true})

	if outcome, err := gate.Ensure(ctx); err != nil || outcome != OutcomeAcknowledged {
		t.Fatalf("Ensure = (%v, %v)", outcome, err)
	}
	// A restart: the notice is not shown again and no second event appears.
	p := &fakePresenter{accept: true}
	if outcome, err := testGate(buffer, p).Ensure(ctx); err != nil || outcome != OutcomeAlreadyAcknowledged {
		t.Fatalf("second Ensure = (%v, %v)", outcome, err)
	}
	if p.count() != 0 {
		t.Error("the notice was shown again after a restart")
	}

	batch, err := buffer.ClaimBatch(ctx, 10)
	if err != nil {
		t.Fatalf("claiming: %v", err)
	}
	if len(batch.Events) != 1 {
		t.Fatalf("the buffer holds %d events, want 1", len(batch.Events))
	}
	if batch.Events[0].Type != store.EventNoticeAck {
		t.Errorf("buffered event type is %q, want %q", batch.Events[0].Type, store.EventNoticeAck)
	}
	if batch.Events[0].ClientEventID == "" {
		t.Error("the store did not assign a client event id")
	}
}
