package tray

import (
	"errors"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// The tray is the agent's visibility guarantee. These tests cover the two things that would break
// it quietly: a status whose label or icon disagrees with reality, and a missing tray being treated
// as survivable.

func TestEveryStatusHasALabelWrittenForTheEmployee(t *testing.T) {
	all := []Status{
		StatusStarting, StatusMonitoring, StatusPaused, StatusNotEnrolled,
		StatusAwaitingNotice, StatusOffline, StatusRevoked, StatusError,
	}

	seen := map[string]Status{}
	for _, status := range all {
		label := status.Label()

		if label == "" || label == "Unknown" {
			t.Errorf("status %d has no label", status)
		}
		if previous, dup := seen[label]; dup {
			t.Errorf("statuses %d and %d share the label %q; an employee could not tell them apart",
				status, previous, label)
		}
		seen[label] = status

		// These are read by the person being monitored, not by an operator.
		for _, jargon := range []string{"_", "filter_reject", "err:", "nil", "goroutine"} {
			if strings.Contains(label, jargon) {
				t.Errorf("label %q contains implementation jargon (%q)", label, jargon)
			}
		}
	}
}

func TestRecordingFlagMatchesTheLabel(t *testing.T) {
	// The icon follows Recording(). If the two disagree, the tray shows a recording icon while
	// saying it is paused — worse than no indicator, because it teaches the employee not to
	// believe it.
	recording := map[Status]bool{
		StatusStarting:       false,
		StatusMonitoring:     true,
		StatusPaused:         false,
		StatusNotEnrolled:    false,
		StatusAwaitingNotice: false,
		StatusOffline:        true, // capture continues; only the upload is stuck
		StatusRevoked:        false,
		StatusError:          false,
	}

	for status, want := range recording {
		if got := status.Recording(); got != want {
			t.Errorf("%s: Recording() = %v, want %v", status.Label(), got, want)
		}
	}
}

func TestOfflineIsDistinctFromMonitoring(t *testing.T) {
	// The state where an employee might otherwise assume their timesheet is current when it is
	// hours behind. It must not be collapsed into "monitoring".
	if StatusOffline.Label() == StatusMonitoring.Label() {
		t.Error("offline and monitoring share a label")
	}
	if !StatusOffline.Recording() {
		t.Error("offline must still count as recording; capture continues while uploads fail")
	}
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

func TestTooltipNamesTheStatus(t *testing.T) {
	state := State{Status: StatusMonitoring}
	tooltip := state.Tooltip()

	if !strings.HasPrefix(tooltip, "WorkLens") {
		t.Errorf("tooltip does not identify the program: %q", tooltip)
	}
	if !strings.Contains(tooltip, "Monitoring is active") {
		t.Errorf("tooltip does not name the status: %q", tooltip)
	}
}

func TestTooltipExplainsWhyItIsPaused(t *testing.T) {
	// "Paused" without a reason invites the assumption that it is broken.
	state := State{Status: StatusPaused, Detail: "outside working hours"}
	if !strings.Contains(state.Tooltip(), "outside working hours") {
		t.Errorf("tooltip omits the pause reason: %q", state.Tooltip())
	}
}

func TestTooltipReportsBufferedWork(t *testing.T) {
	state := State{Status: StatusOffline, BufferedEvents: 42}
	if !strings.Contains(state.Tooltip(), "42 entries waiting") {
		t.Errorf("tooltip omits the buffered count: %q", state.Tooltip())
	}

	// Singular, because "1 entries" reads as a bug and undermines confidence in the rest.
	one := State{Status: StatusOffline, BufferedEvents: 1}
	if !strings.Contains(one.Tooltip(), "1 entry waiting") {
		t.Errorf("tooltip does not use the singular: %q", one.Tooltip())
	}

	// And nothing at all when there is nothing waiting.
	none := State{Status: StatusMonitoring}
	if strings.Contains(none.Tooltip(), "waiting") {
		t.Errorf("tooltip mentions waiting work when there is none: %q", none.Tooltip())
	}
}

func TestTooltipRespectsTheWindowsLengthLimit(t *testing.T) {
	// Windows silently truncates past 127 characters, so a longer tooltip loses its end rather
	// than wrapping.
	state := State{
		Status:         StatusPaused,
		Detail:         strings.Repeat("a very long reason indeed ", 20),
		BufferedEvents: 123456,
	}

	tooltip := state.Tooltip()
	if len(tooltip) > 127 {
		t.Errorf("tooltip is %d characters, above the Windows limit of 127", len(tooltip))
	}
	if !strings.HasSuffix(tooltip, "…") {
		t.Errorf("a truncated tooltip should be marked with an ellipsis: %q", tooltip)
	}
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

func TestMenuLinesAnswerIsThisWorking(t *testing.T) {
	uploaded := time.Date(2026, 8, 19, 14, 2, 0, 0, time.Local)
	state := State{
		Status:       StatusMonitoring,
		EmployeeName: "Asha Rao",
		LastUploadAt: uploaded,
		AgentVersion: "0.1.0",
	}

	joined := strings.Join(state.MenuLines(), "\n")

	for _, want := range []string{"Monitoring is active", "Asha Rao", "Last upload", "Version 0.1.0"} {
		if !strings.Contains(joined, want) {
			t.Errorf("the menu omits %q:\n%s", want, joined)
		}
	}
	if !strings.Contains(joined, "Everything has been uploaded") {
		t.Errorf("the menu does not confirm an empty buffer:\n%s", joined)
	}
}

func TestMenuNamesWhoIsBeingRecorded(t *testing.T) {
	// A shared machine must make clear whose activity this is.
	state := State{Status: StatusMonitoring, EmployeeName: "Asha Rao"}
	if !strings.Contains(strings.Join(state.MenuLines(), "\n"), "Recording for: Asha Rao") {
		t.Error("the menu does not name the employee")
	}
}

func TestMenuReportsHowStaleTheBufferIs(t *testing.T) {
	// "Buffering" is a vague worry; "buffering since 14:02" is a fact someone can act on.
	oldest := time.Date(2026, 8, 19, 14, 2, 0, 0, time.Local)
	state := State{Status: StatusOffline, BufferedEvents: 90, OldestBufferedAt: oldest}

	joined := strings.Join(state.MenuLines(), "\n")
	if !strings.Contains(joined, "90 entries waiting") {
		t.Errorf("the menu omits the buffered count:\n%s", joined)
	}
	if !strings.Contains(joined, "14:02") {
		t.Errorf("the menu omits the age of the oldest entry:\n%s", joined)
	}
}

func TestMenuSaysSoWhenNothingHasEverUploaded(t *testing.T) {
	// A brand-new agent must not imply it has uploaded when it never has.
	state := State{Status: StatusStarting}
	if !strings.Contains(strings.Join(state.MenuLines(), "\n"), "Never uploaded yet") {
		t.Error("the menu does not distinguish 'never uploaded' from 'uploaded a while ago'")
	}
}

func TestMenuGivesThePauseReason(t *testing.T) {
	state := State{Status: StatusPaused, Detail: "application is excluded"}
	if !strings.Contains(strings.Join(state.MenuLines(), "\n"), "Reason: application is excluded") {
		t.Error("the menu does not explain why capture is paused")
	}
}

func TestNoticeItemIsAlwaysAvailable(t *testing.T) {
	// A disclosure an employee can only read once is barely a disclosure.
	if ItemWhatIsRecorded == "" {
		t.Fatal("the notice menu item has no label")
	}
	if !strings.Contains(strings.ToLower(ItemWhatIsRecorded), "recorded") {
		t.Errorf("the notice item label is not self-explanatory: %q", ItemWhatIsRecorded)
	}
}

// ---------------------------------------------------------------------------
// Availability is fatal
// ---------------------------------------------------------------------------

func TestRequireReportsUnavailabilityRatherThanDegrading(t *testing.T) {
	// On a non-Windows build there is no tray. Require must SAY so: the agent's main() turns this
	// into a non-zero exit on Windows, and continuing invisibly would make WorkLens a covert tool.
	controller, err := Require(Callbacks{})

	var unavailable *ErrUnavailable
	if !errors.As(err, &unavailable) {
		t.Fatalf("Require returned err = %v, want ErrUnavailable on a non-Windows build", err)
	}
	if unavailable.Reason == "" {
		t.Error("ErrUnavailable carries no reason for the operator")
	}
	// A usable controller is still returned, so a developer smoke-testing on macOS does not get a
	// nil dereference on top of the error.
	if controller == nil {
		t.Error("Require returned a nil controller alongside the error")
	}
}

func TestErrUnavailableWrapsItsCause(t *testing.T) {
	cause := errors.New("shell notification area refused the icon")
	err := &ErrUnavailable{Reason: "creation failed", Err: cause}

	if !errors.Is(err, cause) {
		t.Error("ErrUnavailable does not unwrap to its cause")
	}
	if !strings.Contains(err.Error(), "creation failed") || !strings.Contains(err.Error(), cause.Error()) {
		t.Errorf("the message loses information: %q", err.Error())
	}
}

// ---------------------------------------------------------------------------
// Headless controller
// ---------------------------------------------------------------------------

func TestHeadlessRecordsEveryStateTransition(t *testing.T) {
	headless := NewHeadless(Callbacks{})

	headless.SetState(State{Status: StatusStarting})
	headless.SetState(State{Status: StatusAwaitingNotice})
	headless.SetState(State{Status: StatusMonitoring})

	if len(headless.States) != 3 {
		t.Fatalf("recorded %d states, want 3", len(headless.States))
	}
	if headless.State().Status != StatusMonitoring {
		t.Errorf("current status = %s, want monitoring", headless.State().Status.Label())
	}
	if headless.States[1].Status != StatusAwaitingNotice {
		t.Error("the intermediate state was not recorded")
	}
}

func TestHeadlessRunReturnsOnQuit(t *testing.T) {
	headless := NewHeadless(Callbacks{})

	readyCalled := make(chan struct{})
	done := make(chan error, 1)
	go func() { done <- headless.Run(func() { close(readyCalled) }) }()

	select {
	case <-readyCalled:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not invoke the ready callback")
	}

	headless.Quit()

	select {
	case err := <-done:
		if err != nil {
			t.Errorf("Run returned %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after Quit")
	}
}

func TestHeadlessQuitIsIdempotent(t *testing.T) {
	// Shutdown can arrive from a signal and from the menu at the same moment; a double close
	// would panic and take the agent down during an orderly stop.
	headless := NewHeadless(Callbacks{})
	headless.Quit()
	headless.Quit()
}

func TestHeadlessForwardsCallbacks(t *testing.T) {
	var notice, dashboard, quit int
	headless := NewHeadless(Callbacks{
		OnShowNotice:    func() { notice++ },
		OnOpenDashboard: func() { dashboard++ },
		OnQuit:          func() { quit++ },
	})

	headless.InvokeShowNotice()
	headless.InvokeOpenDashboard()
	headless.InvokeQuit()

	if notice != 1 || dashboard != 1 || quit != 1 {
		t.Errorf("callbacks fired notice=%d dashboard=%d quit=%d, want 1 each", notice, dashboard, quit)
	}
}

func TestHeadlessToleratesNilCallbacks(t *testing.T) {
	// The dashboard item is omitted when no URL is configured, so its callback is legitimately nil.
	headless := NewHeadless(Callbacks{})
	headless.InvokeShowNotice()
	headless.InvokeOpenDashboard()
	headless.InvokeQuit()
}

func TestTooltipTruncationIsRuneSafe(t *testing.T) {
	// A window title routinely ends in a multi-byte character. Cutting mid-rune emits an invalid
	// UTF-8 sequence, which Windows renders as a replacement box — so the cut walks back to a
	// boundary.
	state := State{
		Status: StatusPaused,
		Detail: strings.Repeat("日本語のウィンドウタイトル ", 20),
	}

	tooltip := state.Tooltip()

	if len(tooltip) > WindowsTooltipLimit {
		t.Errorf("tooltip is %d bytes, above the limit of %d", len(tooltip), WindowsTooltipLimit)
	}
	if !utf8.ValidString(tooltip) {
		t.Errorf("truncation produced invalid UTF-8: %q", tooltip)
	}
	if !strings.HasSuffix(tooltip, "…") {
		t.Errorf("a truncated tooltip is not marked: %q", tooltip)
	}
}

func TestTooltipExactlyAtTheLimitIsNotTruncated(t *testing.T) {
	// An off-by-one here would append an ellipsis to a tooltip that already fitted.
	filler := strings.Repeat("x", WindowsTooltipLimit)
	if got := truncateTooltip(filler); got != filler {
		t.Errorf("a tooltip exactly at the limit was altered: %d bytes", len(got))
	}

	overBy1 := filler + "x"
	got := truncateTooltip(overBy1)
	if len(got) > WindowsTooltipLimit {
		t.Errorf("a tooltip one byte over produced %d bytes", len(got))
	}
	if !strings.HasSuffix(got, "…") {
		t.Error("a tooltip one byte over was not marked as truncated")
	}
}
