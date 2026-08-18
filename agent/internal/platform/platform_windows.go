//go:build windows

package platform

import (
	"errors"
	"image"
	"path/filepath"
	"time"

	"github.com/worklens/worklens/agent/internal/platform/windows"
	"github.com/worklens/worklens/agent/internal/screenshot"
)

// windowsPlatform adapts the Win32 bindings in internal/platform/windows onto the Platform
// interface.
//
// The split is intentional: the bindings package holds the system calls and no policy, and
// this type holds the small amount of translation the rest of the agent depends on —
// splitting an executable path into a base name and a full path, and mapping the "nothing
// has focus" condition onto ErrNoActiveWindow. Keeping the arrow pointing this way
// (platform -> bindings) is also what avoids an import cycle, since the bindings would
// otherwise need this package's types.
//
// It holds no state, so it needs no locking and Close has nothing to release. Every OS
// handle the agent opens is opened and closed inside a single binding call.
type windowsPlatform struct{}

// New returns the Windows implementation of Platform.
//
// It reports no error today. The signature carries one anyway because it is the seam's
// contract on every OS — macOS will need to check for revoked capture permissions here —
// and because a caller written against a signature that cannot fail would have to be
// rewritten the first time it can.
func New() (Platform, error) {
	return windowsPlatform{}, nil
}

// ActiveWindow returns the focused window's executable and caption.
//
// The caption is always read here; whether it is *kept* is the sampler's decision, driven
// by monitoring_config.capture_window_titles. The seam reports what the OS says and the
// layer above applies policy, so there is exactly one place to audit for "what does the
// agent do with a window title".
func (windowsPlatform) ActiveWindow() (WindowInfo, error) {
	hwnd, err := windows.ForegroundWindow()
	if err != nil {
		if errors.Is(err, windows.ErrNoForegroundWindow) {
			return WindowInfo{}, ErrNoActiveWindow
		}
		return WindowInfo{}, err
	}

	// Order matters: resolve the owning executable first. If the foreground window belongs
	// to a process that has already exited, that call fails and the sample is dropped
	// whole, rather than being recorded as a title with no application attached.
	exe, err := windows.WindowProcessImage(hwnd)
	if err != nil {
		if errors.Is(err, windows.ErrNoForegroundWindow) {
			return WindowInfo{}, ErrNoActiveWindow
		}
		return WindowInfo{}, err
	}

	title, err := windows.WindowTitle(hwnd)
	if err != nil {
		return WindowInfo{}, err
	}

	return WindowInfo{
		AppName:     filepath.Base(exe),
		AppExe:      exe,
		WindowTitle: title,
	}, nil
}

// IdleDuration returns the time since the last user input. See
// internal/platform/windows.IdleDuration for the mechanism and for why the tick-count
// arithmetic is done in 32 bits.
func (windowsPlatform) IdleDuration() (time.Duration, error) {
	return windows.IdleDuration()
}

// CaptureScreen returns the current contents of the primary display, unblurred.
//
// Blur is applied by the caller rather than here because it is a configurable privacy
// control with a test that proves it works (internal/screenshot), and folding it into the
// capture call would make "was this image blurred?" a question about a flag deep in the
// platform layer instead of an explicit, visible step in the screenshot pipeline.
func (windowsPlatform) CaptureScreen() (image.Image, error) {
	return screenshot.Capture()
}

// Close releases nothing, because nothing is held open between calls.
func (windowsPlatform) Close() error { return nil }
