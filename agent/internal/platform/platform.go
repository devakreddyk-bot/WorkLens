// Package platform is the seam between the WorkLens agent's capture logic and the
// operating system it observes. Everything above this line — the sampler, the privacy
// filter, the store, the uploader — is ordinary portable Go that can be tested on any
// machine; everything below it is per-OS system calls that can only be exercised on the
// OS in question.
//
// The seam exists for two reasons.
//
// First, testability. The interesting logic in the agent is the state machine that turns
// observations into events (coalescing, idle suppression, title-derived hosts), and none
// of it should require a Windows box to test. A fake Platform makes every one of those
// cases a table-driven unit test.
//
// Second, and more importantly, the seam is the complete inventory of what the agent asks
// the operating system for. There are exactly three questions:
//
//   - which window has focus, and which executable owns it,
//   - how long has it been since the user last interacted with the machine,
//   - what do the pixels on the primary display look like.
//
// That is the whole surface. Idle detection in particular is derived from a single
// counter: Windows reports the tick count at which the last input event arrived, and
// nothing else. There is no key code, no mouse coordinate, no content — not because the
// agent discards it, but because the API used never produces it. No input-monitoring
// hook, raw-input registration, clipboard read, camera, or microphone appears anywhere
// below this seam, and scripts/check-privacy.sh fails the build if one ever does.
package platform

import (
	"errors"
	"image"
	"time"
)

// WindowInfo identifies the application the employee is currently working in.
//
// AppName is the executable's base name because that is what a timesheet is legible in
// ("chrome.exe", "excel.exe"); AppExe is the full path because exclusion rules match on
// it (an "excluded apps" entry of `\Personal\` has to be able to see the directory), and
// because two different programs can share a base name.
//
// There is deliberately no field for anything beyond these three. A window handle, a PID,
// or a process command line would all be more than the product collects.
type WindowInfo struct {
	// AppName is the executable's base name, e.g. "chrome.exe".
	AppName string
	// AppExe is the executable's full path, e.g. `C:\Program Files\Google\Chrome\Application\chrome.exe`.
	AppExe string
	// WindowTitle is the focused window's caption. Empty when title capture is disabled
	// or when the window has no caption.
	WindowTitle string
}

// IsZero reports whether w carries no attribution at all.
//
// This is the shape every idle sample must have: the `activity_events_idle_no_attribution_chk`
// CHECK constraint in the database rejects an entire ingest batch if an idle event arrives
// with an app, a title, or a host attached, so the invariant is asserted on the agent as
// well rather than discovered as a 400 in production.
func (w WindowInfo) IsZero() bool {
	return w == WindowInfo{}
}

// Platform is the per-OS implementation of the three questions above. Use New to obtain
// the implementation for the OS the binary was built for.
//
// Implementations are expected to be safe for use by a single goroutine at a time; the
// agent drives them from one sampling loop, which keeps the system-call layer free of
// locking it does not need.
type Platform interface {
	// ActiveWindow returns the window that currently has focus.
	//
	// It returns ErrNoActiveWindow — not a generic error — when nothing has focus. That
	// is a routine condition (a locked workstation, a desktop switch, the moment after an
	// application exits) and callers must be able to treat it as "no attribution for this
	// sample" without logging it as a fault.
	ActiveWindow() (WindowInfo, error)

	// IdleDuration returns how long it has been since the last user input anywhere on the
	// machine. It reports elapsed time only; the underlying OS call exposes nothing about
	// what the input was.
	IdleDuration() (time.Duration, error)

	// CaptureScreen returns the current contents of the primary display. Callers are
	// expected to apply the blur privacy control (see internal/screenshot) before the
	// image is written anywhere.
	CaptureScreen() (image.Image, error)

	// Close releases any OS resources the implementation holds. It is safe to call more
	// than once.
	Close() error
}

// ErrUnsupported is returned by a Platform implementation for an operating system the
// agent does not support yet. It is a distinct sentinel so that a caller can say "this
// build cannot capture on this OS" rather than surfacing a syscall failure that reads
// like a bug.
var ErrUnsupported = errors.New("platform: capture is not supported on this operating system")

// ErrNoActiveWindow is returned by ActiveWindow when no window has focus.
//
// This is not a failure. It happens every time the workstation locks, every time the user
// switches virtual desktops, and briefly whenever the foreground application exits. The
// sampler treats it as an unattributed sample; if it were folded into a generic error the
// agent's log would fill with noise on every lock screen and real faults would be buried.
var ErrNoActiveWindow = errors.New("platform: no window currently has focus")
