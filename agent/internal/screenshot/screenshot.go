// Package screenshot captures the primary display, applies the blur privacy control, and
// encodes the result as PNG.
//
// Screenshots are the most invasive thing WorkLens can be configured to collect, so they
// are off by default (monitoring_config.screenshot_enabled) and blurred by default
// (screenshot_blur). This package is the implementation of that second control, and the
// blur is written here rather than pulled from an image library on purpose — see blur.go
// for the reasoning and blur_test.go for the test that makes a silent no-op impossible.
//
// Nothing in this package decides *whether* to capture. Work-hours and exclusion checks
// live in internal/privacy and run before an image is written anywhere, so an image that
// should not exist is never persisted (docs/ARCHITECTURE.md §2).
package screenshot

import (
	"errors"
	"fmt"
	"image"

	kbinani "github.com/kbinani/screenshot"
)

// ErrNoDisplay reports that the machine currently has no active display to capture.
//
// This is an ordinary condition rather than a fault: a laptop with the lid closed and no
// external monitor, an RDP session that has been disconnected, or a machine mid-way
// through a display-mode change all produce it. The caller should skip the interval and
// try again at the next tick — treating it as a hard error would take the screenshot loop
// down for the rest of the session over a docking event.
var ErrNoDisplay = errors.New("screenshot: no active display")

// Capture returns the current contents of the primary display.
//
// Only the primary display is captured, deliberately: capturing every monitor multiplies
// both the pixels collected and the chance of catching a window the employee reasonably
// considered off to one side, for no gain in a timesheet. Which display is primary is the
// OS's answer (index 0), which is the same display the employee's taskbar is on.
func Capture() (image.Image, error) {
	if kbinani.NumActiveDisplays() < 1 {
		return nil, ErrNoDisplay
	}

	// The display count and the bounds are two separate queries, so a monitor can be
	// disconnected in between; that shows up as an empty rectangle rather than an error.
	bounds := kbinani.GetDisplayBounds(0)
	if bounds.Empty() {
		return nil, ErrNoDisplay
	}

	img, err := kbinani.CaptureRect(bounds)
	if err != nil {
		return nil, fmt.Errorf("screenshot: capture %dx%d: %w", bounds.Dx(), bounds.Dy(), err)
	}
	if img == nil {
		// Defensive: a nil image with a nil error would otherwise become a nil-pointer
		// panic inside Blur, i.e. a crashed agent, several layers away from the cause.
		return nil, ErrNoDisplay
	}
	return img, nil
}
