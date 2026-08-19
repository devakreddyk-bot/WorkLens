// Package tray is the agent's visible indicator.
//
// # Why this package can fail the whole process
//
// WorkLens promises that the agent is visible while it runs. That promise is kept here, and it
// only means anything if it is unconditional — so **a tray that cannot be created is a fatal
// error, not a degraded mode.** `Require` exists to make that explicit at the call site: the agent
// exits non-zero rather than continuing invisibly.
//
// The reasoning is worth stating plainly, because the opposite choice is the tempting one. If the
// tray failed and the agent carried on, the result would be covert monitoring software running on
// an employee's laptop — precisely the thing this product exists not to be. A monitoring tool that
// silently loses its indicator has become a different product from the one the employee was told
// about and agreed to.
//
// # Structure
//
// Everything with logic — status names, tooltip text, menu labels — lives in this file and is pure
// and tested. The systray binding is behind a build tag and contains no decisions, so a developer
// on macOS can exercise all of it with the headless controller.
package tray

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// Status is what the agent is currently doing, as an employee would describe it.
//
// These strings are read by the person being monitored, so they are written for them rather than
// for an operator: "Paused — outside working hours" rather than "filter_reject:work_hours".
type Status int

const (
	// StatusStarting is the brief window before the first sample.
	StatusStarting Status = iota
	// StatusMonitoring means capture is running normally.
	StatusMonitoring
	// StatusPaused means the privacy filter is currently suppressing capture — outside working
	// hours, or the active application is excluded.
	StatusPaused
	// StatusNotEnrolled means no credential is present, so nothing is captured at all.
	StatusNotEnrolled
	// StatusAwaitingNotice means the employee has not yet acknowledged the first-run notice.
	// Capture has not started and will not until they do.
	StatusAwaitingNotice
	// StatusOffline means capture is running but uploads are failing, so data is buffering
	// locally. Shown distinctly because it is the state where a person might otherwise assume
	// their timesheet is up to date when it is hours behind.
	StatusOffline
	// StatusRevoked means the server has revoked this device. Terminal: capture stops.
	StatusRevoked
	// StatusError means something is wrong that the employee should report.
	StatusError
)

// Label is the short status shown in the menu.
func (s Status) Label() string {
	switch s {
	case StatusStarting:
		return "Starting…"
	case StatusMonitoring:
		return "Monitoring is active"
	case StatusPaused:
		return "Paused — not recording"
	case StatusNotEnrolled:
		return "Not set up — nothing is being recorded"
	case StatusAwaitingNotice:
		return "Waiting for you to read the notice"
	case StatusOffline:
		return "Recording — waiting to upload"
	case StatusRevoked:
		return "Turned off by your administrator"
	case StatusError:
		return "Something is wrong"
	default:
		return "Unknown"
	}
}

// Recording reports whether activity is actually being captured in this state.
//
// Used to choose the icon. It is deliberately a method on Status rather than a field the caller
// sets, so the icon cannot disagree with the label — an indicator showing "recording" while paused,
// or vice versa, is worse than no indicator.
func (s Status) Recording() bool {
	return s == StatusMonitoring || s == StatusOffline
}

// State is everything the tray displays.
type State struct {
	Status Status
	// Detail is the privacy filter's reason when paused, e.g. "outside working hours". Shown to
	// the employee so "why is it not recording?" has an answer.
	Detail string
	// BufferedEvents is how much is waiting to upload.
	BufferedEvents int64
	// LastUploadAt is when data last reached the server. Zero when it never has.
	LastUploadAt time.Time
	// OldestBufferedAt is the timestamp of the oldest unsent event, which is what turns
	// "buffering" into "buffering since 14:02" — the difference between a vague worry and a
	// fact.
	OldestBufferedAt time.Time
	// EmployeeName is shown so a shared machine makes clear whose activity is being recorded.
	EmployeeName string
	// AgentVersion appears in the menu, because the first question support asks is which version.
	AgentVersion string
}

// Tooltip renders the hover text.
//
// Kept under about 127 characters: Windows silently truncates a longer tooltip, so a longer one
// would lose the end of the sentence rather than wrap.
func (s State) Tooltip() string {
	var b strings.Builder
	b.WriteString("WorkLens — ")
	b.WriteString(s.Status.Label())

	if s.Status == StatusPaused && s.Detail != "" {
		b.WriteString(" (")
		b.WriteString(s.Detail)
		b.WriteString(")")
	}

	if s.BufferedEvents > 0 {
		fmt.Fprintf(&b, " · %s waiting", pluralise(s.BufferedEvents, "entry", "entries"))
	}

	return truncateTooltip(b.String())
}

// WindowsTooltipLimit is the length past which Windows silently truncates a tray tooltip.
const WindowsTooltipLimit = 127

// truncateTooltip shortens a tooltip to fit, rune-safely.
//
// Two things make this less trivial than it looks. The ellipsis is a three-byte UTF-8 character,
// so room has to be reserved for it rather than for one byte — the obvious `s[:limit-1] + "…"`
// produces a string two bytes OVER the limit, which is exactly the truncation this function exists
// to avoid. And a window title can end mid-multi-byte-character, so the cut walks back to a rune
// boundary; slicing a byte at a time would emit an invalid rune and Windows renders that as a box.
func truncateTooltip(tooltip string) string {
	if len(tooltip) <= WindowsTooltipLimit {
		return tooltip
	}

	const ellipsis = "…"
	budget := WindowsTooltipLimit - len(ellipsis)

	// Walk back to a rune boundary at or below the budget.
	cut := budget
	for cut > 0 && !utf8.RuneStart(tooltip[cut]) {
		cut--
	}

	return tooltip[:cut] + ellipsis
}

// MenuLines renders the informational (non-clickable) part of the menu.
//
// Everything here is written for the employee. The buffered count and the last upload time are
// included because they are the honest answer to "is this thing working?", and hiding them would
// make the agent feel more opaque than it is.
func (s State) MenuLines() []string {
	lines := []string{s.Status.Label()}

	if s.Status == StatusPaused && s.Detail != "" {
		lines = append(lines, "Reason: "+s.Detail)
	}

	if s.EmployeeName != "" {
		lines = append(lines, "Recording for: "+s.EmployeeName)
	}

	switch {
	case s.BufferedEvents == 0 && !s.LastUploadAt.IsZero():
		lines = append(lines, "Everything has been uploaded")
	case s.BufferedEvents > 0:
		line := fmt.Sprintf("%s waiting to upload", pluralise(s.BufferedEvents, "entry", "entries"))
		if !s.OldestBufferedAt.IsZero() {
			line += ", oldest from " + s.OldestBufferedAt.Local().Format("15:04 on 2 Jan")
		}
		lines = append(lines, line)
	}

	if s.LastUploadAt.IsZero() {
		lines = append(lines, "Never uploaded yet")
	} else {
		lines = append(lines, "Last upload: "+s.LastUploadAt.Local().Format("15:04 on 2 Jan"))
	}

	if s.AgentVersion != "" {
		lines = append(lines, "Version "+s.AgentVersion)
	}

	return lines
}

func pluralise(n int64, singular, plural string) string {
	if n == 1 {
		return fmt.Sprintf("1 %s", singular)
	}
	return fmt.Sprintf("%d %s", n, plural)
}

// Menu item labels. Constants because the Windows binding and the headless implementation must
// agree, and because a test asserts the notice item exists.
const (
	// ItemWhatIsRecorded reopens the notice. An employee must always be able to re-read what is
	// being collected — a disclosure they can only see once is barely a disclosure.
	ItemWhatIsRecorded = "What is being recorded?"
	// ItemOpenDashboard opens the employee's own view of their data.
	ItemOpenDashboard = "See my own data"
	// ItemQuit stops the agent. Present deliberately: the agent runs in the employee's own
	// session at their own integrity level, so they can already stop it from Task Manager. A
	// menu item makes that honest rather than something they have to discover.
	ItemQuit = "Quit WorkLens"
)

// Callbacks are what the tray invokes when an item is chosen. A nil callback means the item is
// omitted, which is how the dashboard entry disappears when no URL is configured.
type Callbacks struct {
	OnShowNotice    func()
	OnOpenDashboard func()
	OnQuit          func()
}

// Controller is the tray as the rest of the agent sees it.
type Controller interface {
	// Run takes over the calling goroutine until Quit is called or the process ends. On Windows
	// the tray must own the main thread, which is why this is Run rather than Start.
	Run(ready func()) error
	// SetState updates the icon, tooltip and menu.
	SetState(state State)
	// Quit tears the tray down and causes Run to return.
	Quit()
}

// ErrUnavailable means no tray could be created.
//
// The agent treats this as fatal. See the package documentation: continuing without an indicator
// would turn a transparent tool into a covert one.
type ErrUnavailable struct {
	Reason string
	Err    error
}

func (e *ErrUnavailable) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("tray: unavailable (%s): %v", e.Reason, e.Err)
	}
	return fmt.Sprintf("tray: unavailable (%s)", e.Reason)
}

func (e *ErrUnavailable) Unwrap() error { return e.Err }

// Require returns the controller and, if no real tray could be created, an error the caller must
// treat as fatal on Windows.
//
// A thin wrapper with a blunt name, because the name is the documentation at the call site: it
// reads `tray.Require(...)`, which is harder to follow with a logged warning and a carry-on than a
// function called `New` would be.
//
// Note that a controller is returned **alongside** any error, never instead of it. Returning nil
// with the error would mean every caller had to nil-check before it could even log the failure, and
// the one place that gets skipped is a nil dereference during startup — a crash instead of the
// clear "no visible indicator, refusing to run" the design wants.
func Require(callbacks Callbacks) (Controller, error) {
	return newPlatformController(callbacks)
}

// Headless is a Controller that displays nothing.
//
// Two legitimate uses: tests, and development on a machine with no Windows tray. It is NOT a
// fallback for a failed tray on a real deployment — `Require` never returns it, because a
// silent fallback to an invisible agent is exactly the outcome the design forbids.
type Headless struct {
	callbacks Callbacks
	state     State
	quit      chan struct{}
	// States records every state it was given, so a test can assert on transitions rather than
	// only on the final value.
	States []State
}

// NewHeadless builds an invisible controller for tests and non-Windows development.
func NewHeadless(callbacks Callbacks) *Headless {
	return &Headless{callbacks: callbacks, quit: make(chan struct{})}
}

// Run blocks until Quit.
func (h *Headless) Run(ready func()) error {
	if ready != nil {
		ready()
	}
	<-h.quit
	return nil
}

// SetState records the state.
func (h *Headless) SetState(state State) {
	h.state = state
	h.States = append(h.States, state)
}

// State returns the most recent state.
func (h *Headless) State() State { return h.state }

// Quit unblocks Run. Safe to call more than once, because shutdown can arrive from a signal and
// from the menu at the same moment.
func (h *Headless) Quit() {
	select {
	case <-h.quit:
	default:
		close(h.quit)
	}
}

// InvokeShowNotice simulates the employee choosing the notice item, for tests.
func (h *Headless) InvokeShowNotice() {
	if h.callbacks.OnShowNotice != nil {
		h.callbacks.OnShowNotice()
	}
}

// InvokeOpenDashboard simulates the dashboard item.
func (h *Headless) InvokeOpenDashboard() {
	if h.callbacks.OnOpenDashboard != nil {
		h.callbacks.OnOpenDashboard()
	}
}

// InvokeQuit simulates the quit item.
func (h *Headless) InvokeQuit() {
	if h.callbacks.OnQuit != nil {
		h.callbacks.OnQuit()
	}
	h.Quit()
}
