package store

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// The buffer is what makes the agent survive being offline. These tests concentrate on the
// cases where a bug loses data or silently stops sending: the claim protocol, crash recovery,
// and the cap.

func newTestStore(t *testing.T, opts Options) *Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "buffer.db")
	s, err := Open(path, opts)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

// fixedClock lets the cap and claim-expiry tests move time without sleeping.
type fixedClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fixedClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fixedClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func sample(when time.Time) Event {
	return Event{
		Type:        EventWindowSample,
		CapturedAt:  when,
		Duration:    60 * time.Second,
		AppName:     "code.exe",
		AppExe:      `C:\Program Files\Microsoft VS Code\code.exe`,
		WindowTitle: "store.go - worklens",
	}
}

// ---------------------------------------------------------------------------
// Validation — mirroring the server's constraints
// ---------------------------------------------------------------------------

func TestEventValidation(t *testing.T) {
	now := time.Now()

	cases := []struct {
		name    string
		event   Event
		wantErr string
	}{
		{"valid sample", sample(now), ""},
		{
			name: "unknown event type",
			// A deliberately bogus type. Note it is NOT spelled as any forbidden capture
			// concept: scripts/check-privacy.sh scans test files too, and rightly rejected an
			// earlier draft of this line.
			event:   Event{Type: "screen_recording", CapturedAt: now},
			wantErr: "not a valid event type",
		},
		{
			name:    "missing captured_at",
			event:   Event{Type: EventWindowSample},
			wantErr: "no captured_at",
		},
		{
			name:    "duration beyond the server's cap",
			event:   Event{Type: EventWindowSample, CapturedAt: now, Duration: 2 * time.Hour},
			wantErr: "outside the accepted range",
		},
		{
			name:    "negative duration",
			event:   Event{Type: EventWindowSample, CapturedAt: now, Duration: -time.Second},
			wantErr: "outside the accepted range",
		},
		{
			// The server's activity_events_idle_no_attribution_chk rejects the entire batch, so
			// catching this locally protects every other event batched with it.
			name: "idle event carrying a window title",
			event: Event{
				Type: EventIdleState, CapturedAt: now, IsIdle: true,
				WindowTitle: "Internet Banking - Chrome",
			},
			wantErr: "must carry no application, title or host",
		},
		{
			name:  "idle event with no attribution is fine",
			event: Event{Type: EventIdleState, CapturedAt: now, IsIdle: true, Duration: 5 * time.Minute},
		},
	}

	for _, tc := range cases {
		err := tc.event.Validate()
		if tc.wantErr == "" {
			if err != nil {
				t.Errorf("%s: unexpected error %v", tc.name, err)
			}
			continue
		}
		if err == nil {
			t.Errorf("%s: expected an error containing %q, got nil", tc.name, tc.wantErr)
			continue
		}
		if !strings.Contains(err.Error(), tc.wantErr) {
			t.Errorf("%s: error %q does not contain %q", tc.name, err, tc.wantErr)
		}
	}
}

func TestAppendRejectsInvalidEvents(t *testing.T) {
	s := newTestStore(t, Options{})
	ctx := context.Background()

	if _, err := s.AppendEvent(ctx, Event{Type: EventIdleState, CapturedAt: time.Now(), IsIdle: true, AppName: "chrome.exe"}); err == nil {
		t.Error("an idle event with attribution was buffered; it must be rejected before it can poison a batch")
	}

	stats, err := s.Stats(ctx)
	if err != nil {
		t.Fatalf("Stats failed: %v", err)
	}
	if stats.Events != 0 {
		t.Errorf("a rejected event was still stored: %d rows", stats.Events)
	}
}

// ---------------------------------------------------------------------------
// Client event ids
// ---------------------------------------------------------------------------

func TestClientEventIDsAreUniqueAndWellFormed(t *testing.T) {
	seen := make(map[string]struct{}, 1000)
	for i := 0; i < 1000; i++ {
		id, err := NewClientEventID()
		if err != nil {
			t.Fatalf("NewClientEventID failed: %v", err)
		}
		if len(id) != 36 {
			t.Fatalf("id %q is not 36 characters", id)
		}
		// The server's column is uuid; a malformed value fails the insert for the whole batch.
		if id[14] != '4' {
			t.Fatalf("id %q is not version 4", id)
		}
		if _, dup := seen[id]; dup {
			t.Fatalf("NewClientEventID repeated a value after %d draws", i)
		}
		seen[id] = struct{}{}
	}
}

func TestAppendAssignsAnIDAndPreservesAGivenOne(t *testing.T) {
	s := newTestStore(t, Options{})
	ctx := context.Background()

	assigned, err := s.AppendEvent(ctx, sample(time.Now()))
	if err != nil {
		t.Fatalf("AppendEvent failed: %v", err)
	}
	if assigned == "" {
		t.Error("AppendEvent did not assign a client event id")
	}

	explicit := sample(time.Now())
	explicit.ClientEventID = "11111111-1111-4111-8111-111111111111"
	got, err := s.AppendEvent(ctx, explicit)
	if err != nil {
		t.Fatalf("AppendEvent failed: %v", err)
	}
	if got != explicit.ClientEventID {
		t.Errorf("AppendEvent replaced a supplied id: got %q", got)
	}
}

func TestDuplicateClientEventIDIsRejected(t *testing.T) {
	// The unique index is what makes a local retry safe: re-buffering the same event must not
	// create a second copy that the server then has to deduplicate.
	s := newTestStore(t, Options{})
	ctx := context.Background()

	e := sample(time.Now())
	e.ClientEventID = "22222222-2222-4222-8222-222222222222"

	if _, err := s.AppendEvent(ctx, e); err != nil {
		t.Fatalf("first append failed: %v", err)
	}
	if _, err := s.AppendEvent(ctx, e); err == nil {
		t.Error("the same client event id was buffered twice")
	}
}

// ---------------------------------------------------------------------------
// The claim protocol
// ---------------------------------------------------------------------------

func TestClaimBatchReturnsOldestFirst(t *testing.T) {
	// Draining in order means a long offline period fills a timesheet chronologically rather
	// than arriving scrambled.
	s := newTestStore(t, Options{})
	ctx := context.Background()
	base := time.Date(2026, 8, 19, 9, 0, 0, 0, time.UTC)

	for i := 0; i < 5; i++ {
		e := sample(base.Add(time.Duration(i) * time.Minute))
		e.Detail = fmt.Sprintf("event-%d", i)
		if _, err := s.AppendEvent(ctx, e); err != nil {
			t.Fatalf("AppendEvent failed: %v", err)
		}
	}

	batch, err := s.ClaimBatch(ctx, 3)
	if err != nil {
		t.Fatalf("ClaimBatch failed: %v", err)
	}
	if len(batch.Events) != 3 {
		t.Fatalf("claimed %d events, want 3", len(batch.Events))
	}
	for i, e := range batch.Events {
		if want := fmt.Sprintf("event-%d", i); e.Detail != want {
			t.Errorf("event %d is %q, want %q — batch is not oldest-first", i, e.Detail, want)
		}
	}
}

func TestClaimBatchRoundTripsEveryField(t *testing.T) {
	s := newTestStore(t, Options{})
	ctx := context.Background()

	original := Event{
		Type:        EventWindowSample,
		CapturedAt:  time.Date(2026, 8, 19, 9, 30, 0, 0, time.UTC),
		Duration:    120 * time.Second,
		IsIdle:      false,
		AppName:     "chrome.exe",
		AppExe:      `C:\Program Files\Google\Chrome\Application\chrome.exe`,
		WindowTitle: "worklens — Pull requests — Google Chrome",
		URLHost:     "github.com",
		URLTitle:    "worklens — Pull requests",
		Detail:      "",
	}
	if _, err := s.AppendEvent(ctx, original); err != nil {
		t.Fatalf("AppendEvent failed: %v", err)
	}

	batch, err := s.ClaimBatch(ctx, 10)
	if err != nil {
		t.Fatalf("ClaimBatch failed: %v", err)
	}
	got := batch.Events[0]

	if !got.CapturedAt.Equal(original.CapturedAt) {
		t.Errorf("captured_at round trip: got %v, want %v", got.CapturedAt, original.CapturedAt)
	}
	if got.Duration != original.Duration {
		t.Errorf("duration round trip: got %v, want %v", got.Duration, original.Duration)
	}
	for name, pair := range map[string][2]string{
		"app_name":     {got.AppName, original.AppName},
		"app_exe":      {got.AppExe, original.AppExe},
		"window_title": {got.WindowTitle, original.WindowTitle},
		"url_host":     {got.URLHost, original.URLHost},
		"url_title":    {got.URLTitle, original.URLTitle},
	} {
		if pair[0] != pair[1] {
			t.Errorf("%s round trip: got %q, want %q", name, pair[0], pair[1])
		}
	}
}

func TestClaimedEventsAreNotClaimedTwice(t *testing.T) {
	// Two uploader goroutines must never send the same rows: the server would deduplicate, but
	// the bandwidth and the confusion are real.
	s := newTestStore(t, Options{})
	ctx := context.Background()

	for i := 0; i < 10; i++ {
		if _, err := s.AppendEvent(ctx, sample(time.Now().Add(time.Duration(i)*time.Second))); err != nil {
			t.Fatalf("AppendEvent failed: %v", err)
		}
	}

	first, err := s.ClaimBatch(ctx, 4)
	if err != nil {
		t.Fatalf("first ClaimBatch failed: %v", err)
	}
	second, err := s.ClaimBatch(ctx, 4)
	if err != nil {
		t.Fatalf("second ClaimBatch failed: %v", err)
	}

	if first.ClaimID == second.ClaimID {
		t.Fatal("two claims shared a claim id")
	}

	seen := make(map[string]struct{})
	for _, e := range first.Events {
		seen[e.ClientEventID] = struct{}{}
	}
	for _, e := range second.Events {
		if _, dup := seen[e.ClientEventID]; dup {
			t.Errorf("event %s was claimed by both batches", e.ClientEventID)
		}
	}
}

func TestConcurrentClaimsDoNotOverlap(t *testing.T) {
	s := newTestStore(t, Options{})
	ctx := context.Background()

	const total = 200
	for i := 0; i < total; i++ {
		if _, err := s.AppendEvent(ctx, sample(time.Now().Add(time.Duration(i)*time.Second))); err != nil {
			t.Fatalf("AppendEvent failed: %v", err)
		}
	}

	var (
		mu     sync.Mutex
		seen   = make(map[string]int)
		wg     sync.WaitGroup
		claims int
	)

	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				batch, err := s.ClaimBatch(ctx, 7)
				if err != nil {
					t.Errorf("ClaimBatch failed: %v", err)
					return
				}
				if batch.Empty() {
					return
				}
				mu.Lock()
				claims++
				for _, e := range batch.Events {
					seen[e.ClientEventID]++
				}
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	if len(seen) != total {
		t.Errorf("claimed %d distinct events, want %d", len(seen), total)
	}
	for id, count := range seen {
		if count != 1 {
			t.Errorf("event %s was claimed %d times", id, count)
		}
	}
}

func TestDeleteBatchRemovesOnlyThatClaim(t *testing.T) {
	s := newTestStore(t, Options{})
	ctx := context.Background()

	for i := 0; i < 6; i++ {
		if _, err := s.AppendEvent(ctx, sample(time.Now().Add(time.Duration(i)*time.Second))); err != nil {
			t.Fatalf("AppendEvent failed: %v", err)
		}
	}

	first, _ := s.ClaimBatch(ctx, 2)
	second, _ := s.ClaimBatch(ctx, 2)

	deleted, err := s.DeleteBatch(ctx, first.ClaimID)
	if err != nil {
		t.Fatalf("DeleteBatch failed: %v", err)
	}
	if deleted != 2 {
		t.Errorf("deleted %d rows, want 2", deleted)
	}

	stats, _ := s.Stats(ctx)
	if stats.Events != 4 {
		t.Errorf("%d events remain, want 4", stats.Events)
	}
	if stats.ClaimedEvents != 2 {
		t.Errorf("%d events still claimed, want 2 (the second batch)", stats.ClaimedEvents)
	}
	_ = second
}

func TestReleaseBatchMakesEventsClaimableAgain(t *testing.T) {
	// This is the retry path: a 500 or a timeout releases the batch, and the next attempt must
	// pick up exactly those rows rather than skipping them.
	s := newTestStore(t, Options{})
	ctx := context.Background()

	for i := 0; i < 3; i++ {
		if _, err := s.AppendEvent(ctx, sample(time.Now().Add(time.Duration(i)*time.Second))); err != nil {
			t.Fatalf("AppendEvent failed: %v", err)
		}
	}

	batch, _ := s.ClaimBatch(ctx, 3)
	if empty, _ := s.ClaimBatch(ctx, 3); !empty.Empty() {
		t.Fatal("events were claimable while already claimed")
	}

	released, err := s.ReleaseBatch(ctx, batch.ClaimID)
	if err != nil {
		t.Fatalf("ReleaseBatch failed: %v", err)
	}
	if released != 3 {
		t.Errorf("released %d rows, want 3", released)
	}

	again, err := s.ClaimBatch(ctx, 3)
	if err != nil {
		t.Fatalf("ClaimBatch after release failed: %v", err)
	}
	if len(again.Events) != 3 {
		t.Errorf("reclaimed %d events after release, want 3", len(again.Events))
	}
}

func TestClaimBatchRejectsNonPositiveSize(t *testing.T) {
	s := newTestStore(t, Options{})
	if _, err := s.ClaimBatch(context.Background(), 0); err == nil {
		t.Error("a zero batch size was accepted")
	}
}

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------

func TestRecoverReleasesStaleClaims(t *testing.T) {
	// Without this, a process killed mid-upload leaves rows claimed forever: the buffer grows
	// while appearing to have nothing to send.
	clock := &fixedClock{now: time.Date(2026, 8, 19, 9, 0, 0, 0, time.UTC)}
	s := newTestStore(t, Options{StaleClaimAfter: 10 * time.Minute, Now: clock.Now})
	ctx := context.Background()

	for i := 0; i < 4; i++ {
		if _, err := s.AppendEvent(ctx, sample(clock.Now())); err != nil {
			t.Fatalf("AppendEvent failed: %v", err)
		}
	}
	if _, err := s.ClaimBatch(ctx, 4); err != nil {
		t.Fatalf("ClaimBatch failed: %v", err)
	}

	// A fresh claim must be left alone — releasing it would resend rows underneath an upload
	// that is still in flight.
	events, _, err := s.Recover(ctx)
	if err != nil {
		t.Fatalf("Recover failed: %v", err)
	}
	if events != 0 {
		t.Errorf("Recover released %d fresh claims; it must leave in-flight uploads alone", events)
	}

	clock.advance(11 * time.Minute)

	events, _, err = s.Recover(ctx)
	if err != nil {
		t.Fatalf("Recover failed: %v", err)
	}
	if events != 4 {
		t.Errorf("Recover released %d stale claims, want 4", events)
	}

	batch, _ := s.ClaimBatch(ctx, 4)
	if len(batch.Events) != 4 {
		t.Errorf("after recovery %d events were claimable, want 4", len(batch.Events))
	}
}

func TestBufferSurvivesReopen(t *testing.T) {
	// The whole point of the buffer: a restart must not lose what has not been uploaded.
	path := filepath.Join(t.TempDir(), "buffer.db")

	first, err := Open(path, Options{})
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	ctx := context.Background()
	for i := 0; i < 5; i++ {
		if _, err := first.AppendEvent(ctx, sample(time.Now().Add(time.Duration(i)*time.Second))); err != nil {
			t.Fatalf("AppendEvent failed: %v", err)
		}
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close failed: %v", err)
	}

	second, err := Open(path, Options{})
	if err != nil {
		t.Fatalf("reopen failed: %v", err)
	}
	defer func() { _ = second.Close() }()

	stats, err := second.Stats(ctx)
	if err != nil {
		t.Fatalf("Stats failed: %v", err)
	}
	if stats.Events != 5 {
		t.Errorf("%d events survived the restart, want 5", stats.Events)
	}
}

// ---------------------------------------------------------------------------
// The cap
// ---------------------------------------------------------------------------

func TestEnforceCapDropsOldestFirst(t *testing.T) {
	// Recent activity is most of what a timesheet is about, so the oldest must go first.
	clock := &fixedClock{now: time.Date(2026, 8, 19, 9, 0, 0, 0, time.UTC)}
	s := newTestStore(t, Options{MaxBytes: 2000, Now: clock.Now})
	ctx := context.Background()

	base := clock.Now()
	for i := 0; i < 30; i++ {
		e := sample(base.Add(time.Duration(i) * time.Minute))
		e.Detail = fmt.Sprintf("event-%02d", i)
		if _, err := s.AppendEvent(ctx, e); err != nil {
			t.Fatalf("AppendEvent failed: %v", err)
		}
	}

	before, _ := s.Stats(ctx)
	if before.EstimatedBytes <= 2000 {
		t.Fatalf("test setup did not exceed the cap: %d bytes", before.EstimatedBytes)
	}

	_, droppedByCap, err := s.EnforceCap(ctx)
	if err != nil {
		t.Fatalf("EnforceCap failed: %v", err)
	}
	if droppedByCap == 0 {
		t.Fatal("EnforceCap dropped nothing despite being over the cap")
	}

	batch, _ := s.ClaimBatch(ctx, 100)
	if len(batch.Events) == 0 {
		t.Fatal("everything was dropped")
	}

	// The survivors must be the newest ones, contiguous from the end.
	firstSurvivor := batch.Events[0].Detail
	lastSurvivor := batch.Events[len(batch.Events)-1].Detail
	if lastSurvivor != "event-29" {
		t.Errorf("the newest event was dropped: last survivor is %q", lastSurvivor)
	}
	if firstSurvivor == "event-00" {
		t.Error("the oldest event survived a cap sweep")
	}
}

func TestEnforceCapDropsAgedOutEvents(t *testing.T) {
	clock := &fixedClock{now: time.Date(2026, 8, 19, 9, 0, 0, 0, time.UTC)}
	s := newTestStore(t, Options{MaxAge: 24 * time.Hour, Now: clock.Now})
	ctx := context.Background()

	old := sample(clock.Now().Add(-48 * time.Hour))
	old.Detail = "stale"
	fresh := sample(clock.Now())
	fresh.Detail = "fresh"

	if _, err := s.AppendEvent(ctx, old); err != nil {
		t.Fatalf("AppendEvent failed: %v", err)
	}
	if _, err := s.AppendEvent(ctx, fresh); err != nil {
		t.Fatalf("AppendEvent failed: %v", err)
	}

	droppedByAge, _, err := s.EnforceCap(ctx)
	if err != nil {
		t.Fatalf("EnforceCap failed: %v", err)
	}
	if droppedByAge != 1 {
		t.Errorf("dropped %d aged-out events, want 1", droppedByAge)
	}

	batch, _ := s.ClaimBatch(ctx, 10)
	if len(batch.Events) != 1 || batch.Events[0].Detail != "fresh" {
		t.Errorf("the wrong event survived the age sweep: %+v", batch.Events)
	}
}

func TestEnforceCapNeverTouchesClaimedRows(t *testing.T) {
	// An upload in flight must not have its rows deleted underneath it — the uploader would
	// then delete a claim that no longer exists and silently lose the events.
	clock := &fixedClock{now: time.Date(2026, 8, 19, 9, 0, 0, 0, time.UTC)}
	s := newTestStore(t, Options{MaxAge: time.Hour, MaxBytes: 1, Now: clock.Now})
	ctx := context.Background()

	for i := 0; i < 5; i++ {
		e := sample(clock.Now().Add(-48 * time.Hour))
		e.Detail = fmt.Sprintf("old-%d", i)
		if _, err := s.AppendEvent(ctx, e); err != nil {
			t.Fatalf("AppendEvent failed: %v", err)
		}
	}

	batch, _ := s.ClaimBatch(ctx, 5)
	if len(batch.Events) != 5 {
		t.Fatalf("claimed %d events, want 5", len(batch.Events))
	}

	if _, _, err := s.EnforceCap(ctx); err != nil {
		t.Fatalf("EnforceCap failed: %v", err)
	}

	stats, _ := s.Stats(ctx)
	if stats.Events != 5 {
		t.Errorf("EnforceCap deleted claimed rows: %d remain, want 5", stats.Events)
	}

	// The claim is still valid, so the upload can complete.
	deleted, err := s.DeleteBatch(ctx, batch.ClaimID)
	if err != nil {
		t.Fatalf("DeleteBatch failed: %v", err)
	}
	if deleted != 5 {
		t.Errorf("deleted %d rows after the sweep, want 5", deleted)
	}
}

func TestEnforceCapIsANoOpUnderTheLimit(t *testing.T) {
	s := newTestStore(t, Options{})
	ctx := context.Background()

	if _, err := s.AppendEvent(ctx, sample(time.Now())); err != nil {
		t.Fatalf("AppendEvent failed: %v", err)
	}

	byAge, byCap, err := s.EnforceCap(ctx)
	if err != nil {
		t.Fatalf("EnforceCap failed: %v", err)
	}
	if byAge != 0 || byCap != 0 {
		t.Errorf("EnforceCap dropped %d+%d events while under the limits", byAge, byCap)
	}
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

func TestScreenshotQueue(t *testing.T) {
	s := newTestStore(t, Options{})
	ctx := context.Background()
	dir := t.TempDir()

	path := filepath.Join(dir, "shot.png")
	if err := os.WriteFile(path, []byte("not-really-a-png"), 0o600); err != nil {
		t.Fatalf("could not write the fixture image: %v", err)
	}

	id, err := s.EnqueueScreenshot(ctx, Screenshot{
		CapturedAt: time.Now(), Path: path,
		Width: 1920, Height: 1080, ByteCount: 16,
		SHA256: "abc123", Blurred: true,
	})
	if err != nil {
		t.Fatalf("EnqueueScreenshot failed: %v", err)
	}
	if id == 0 {
		t.Error("EnqueueScreenshot returned no id")
	}

	claimID, shots, err := s.ClaimScreenshots(ctx, 10)
	if err != nil {
		t.Fatalf("ClaimScreenshots failed: %v", err)
	}
	if len(shots) != 1 {
		t.Fatalf("claimed %d screenshots, want 1", len(shots))
	}
	if !shots[0].Blurred {
		t.Error("the blurred flag did not round trip; the dashboard shows it to a viewer")
	}
	if shots[0].Width != 1920 || shots[0].Height != 1080 {
		t.Errorf("dimensions did not round trip: %dx%d", shots[0].Width, shots[0].Height)
	}

	if _, again, _ := s.ClaimScreenshots(ctx, 10); len(again) != 0 {
		t.Error("a claimed screenshot was claimed again")
	}

	if _, err := s.ReleaseScreenshots(ctx, claimID); err != nil {
		t.Fatalf("ReleaseScreenshots failed: %v", err)
	}
	if _, reclaimed, _ := s.ClaimScreenshots(ctx, 10); len(reclaimed) != 1 {
		t.Error("a released screenshot was not claimable again")
	}

	if err := s.DeleteScreenshot(ctx, id, path); err != nil {
		t.Fatalf("DeleteScreenshot failed: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("DeleteScreenshot left the image file on disk; that is a privacy problem, not just wasted space")
	}

	stats, _ := s.Stats(ctx)
	if stats.Screenshots != 0 {
		t.Errorf("%d screenshot rows remain after deletion", stats.Screenshots)
	}
}

func TestDeleteScreenshotToleratesAMissingFile(t *testing.T) {
	// The file may already be gone — a cleanup tool, an antivirus quarantine. The row must
	// still be removed, or the uploader retries it forever.
	s := newTestStore(t, Options{})
	ctx := context.Background()

	id, err := s.EnqueueScreenshot(ctx, Screenshot{
		CapturedAt: time.Now(), Path: filepath.Join(t.TempDir(), "vanished.png"),
		Width: 1, Height: 1, ByteCount: 0, SHA256: "x",
	})
	if err != nil {
		t.Fatalf("EnqueueScreenshot failed: %v", err)
	}

	if err := s.DeleteScreenshot(ctx, id, filepath.Join(t.TempDir(), "vanished.png")); err != nil {
		t.Errorf("DeleteScreenshot failed on a missing file: %v", err)
	}

	stats, _ := s.Stats(ctx)
	if stats.Screenshots != 0 {
		t.Error("the queue row survived deletion of a missing file")
	}
}

func TestEnqueueScreenshotRequiresPathAndTime(t *testing.T) {
	s := newTestStore(t, Options{})
	ctx := context.Background()

	if _, err := s.EnqueueScreenshot(ctx, Screenshot{CapturedAt: time.Now()}); err == nil {
		t.Error("a screenshot with no path was accepted")
	}
	if _, err := s.EnqueueScreenshot(ctx, Screenshot{Path: "x.png"}); err == nil {
		t.Error("a screenshot with no captured_at was accepted")
	}
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

func TestMetaRoundTripAndUpsert(t *testing.T) {
	s := newTestStore(t, Options{})
	ctx := context.Background()

	if _, ok, err := s.GetMeta(ctx, MetaNoticeAcknowledgedAt); err != nil || ok {
		t.Errorf("a missing key reported ok=%v err=%v; the first run has none of them", ok, err)
	}

	if err := s.SetMeta(ctx, MetaConfigVersion, "7"); err != nil {
		t.Fatalf("SetMeta failed: %v", err)
	}
	value, ok, err := s.GetMeta(ctx, MetaConfigVersion)
	if err != nil || !ok || value != "7" {
		t.Errorf("GetMeta = (%q, %v, %v), want (7, true, nil)", value, ok, err)
	}

	if err := s.SetMeta(ctx, MetaConfigVersion, "8"); err != nil {
		t.Fatalf("SetMeta upsert failed: %v", err)
	}
	value, _, _ = s.GetMeta(ctx, MetaConfigVersion)
	if value != "8" {
		t.Errorf("after upsert GetMeta = %q, want 8", value)
	}
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

func TestStatsReportsOldestCapturedAt(t *testing.T) {
	// The tray tooltip and agentctl doctor show this: "buffered since 14:02" is what tells
	// someone the agent has been offline rather than idle.
	s := newTestStore(t, Options{})
	ctx := context.Background()

	oldest := time.Date(2026, 8, 19, 9, 0, 0, 0, time.UTC)
	for i := 0; i < 3; i++ {
		if _, err := s.AppendEvent(ctx, sample(oldest.Add(time.Duration(i)*time.Hour))); err != nil {
			t.Fatalf("AppendEvent failed: %v", err)
		}
	}

	stats, err := s.Stats(ctx)
	if err != nil {
		t.Fatalf("Stats failed: %v", err)
	}
	if !stats.OldestCapturedAt.Equal(oldest) {
		t.Errorf("OldestCapturedAt = %v, want %v", stats.OldestCapturedAt, oldest)
	}
	if stats.FileBytes == 0 {
		t.Error("FileBytes was not measured")
	}
}

func TestVacuum(t *testing.T) {
	s := newTestStore(t, Options{})
	ctx := context.Background()

	for i := 0; i < 200; i++ {
		if _, err := s.AppendEvent(ctx, sample(time.Now().Add(time.Duration(i)*time.Second))); err != nil {
			t.Fatalf("AppendEvent failed: %v", err)
		}
	}
	batch, _ := s.ClaimBatch(ctx, 200)
	if _, err := s.DeleteBatch(ctx, batch.ClaimID); err != nil {
		t.Fatalf("DeleteBatch failed: %v", err)
	}

	if err := s.Vacuum(ctx); err != nil {
		t.Errorf("Vacuum failed: %v", err)
	}
}

func TestNullableStoresNullNotEmptyString(t *testing.T) {
	// The server's idle-attribution CHECK is written against NULL, and it distinguishes "no
	// application" from "an application named the empty string".
	s := newTestStore(t, Options{})
	ctx := context.Background()

	e := Event{Type: EventIdleState, CapturedAt: time.Now(), IsIdle: true, Duration: time.Minute}
	if _, err := s.AppendEvent(ctx, e); err != nil {
		t.Fatalf("AppendEvent failed: %v", err)
	}

	var appName *string
	if err := s.db.QueryRowContext(ctx, `select app_name from events limit 1`).Scan(&appName); err != nil {
		t.Fatalf("query failed: %v", err)
	}
	if appName != nil {
		t.Errorf("app_name stored as %q, want NULL", *appName)
	}
}
