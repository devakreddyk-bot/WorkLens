//go:build darwin

package platform

import (
	"image"
	"time"
)

// This file exists so that the whole agent — sampler, privacy filter, store, uploader —
// compiles and tests on the macOS machines it is developed on. It is not a placeholder
// waiting to be filled in.
//
// macOS support is future work, and it is *product* work rather than a porting exercise.
// The equivalents of the three calls this seam needs all sit behind user-visible macOS
// privacy gates: reading another application's window title requires the Accessibility
// permission, and screen capture requires Screen Recording. Both prompt the person being
// monitored, both can be revoked at any moment, and an agent that silently produces empty
// samples after a revocation would misreport someone's working day. Shipping macOS
// therefore means designing how those permissions are requested, how a denial is
// surfaced in the tray, and how a revoked permission is reported to the dashboard as a
// gap rather than as idleness — see docs/AGENT.md.
//
// Until that design exists, every call returns ErrUnsupported. Quietly implementing the
// syscalls here without the permission handling would produce an agent that appears to
// work and lies about employees' time, which is worse than one that refuses to run.

// darwinPlatform reports ErrUnsupported for every operation. See the file comment above.
type darwinPlatform struct{}

// New returns the macOS Platform, which does not capture anything, together with
// ErrUnsupported.
//
// The error and a usable value are returned together on purpose: a caller that logs the
// error and carries on gets a Platform whose methods fail cleanly, rather than a nil
// interface that panics on first use. Returning nil here would turn a known, documented
// limitation into a crash.
func New() (Platform, error) {
	return darwinPlatform{}, ErrUnsupported
}

// ActiveWindow always returns ErrUnsupported on macOS.
func (darwinPlatform) ActiveWindow() (WindowInfo, error) {
	return WindowInfo{}, ErrUnsupported
}

// IdleDuration always returns ErrUnsupported on macOS.
func (darwinPlatform) IdleDuration() (time.Duration, error) {
	return 0, ErrUnsupported
}

// CaptureScreen always returns ErrUnsupported on macOS.
//
// internal/screenshot can in fact capture on macOS, but the Platform seam deliberately
// does not expose that: a half-supported OS where screenshots work and activity
// attribution does not would produce timesheets with images and no hours.
func (darwinPlatform) CaptureScreen() (image.Image, error) {
	return nil, ErrUnsupported
}

// Close is a no-op: nothing was ever opened.
func (darwinPlatform) Close() error { return nil }
