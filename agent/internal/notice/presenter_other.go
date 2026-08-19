//go:build !windows

package notice

import "errors"

// ErrUnsupported reports that this build cannot show the notice window.
//
// It is a distinct sentinel, in the same spirit as platform.ErrUnsupported, so that a caller can
// say "this build cannot ask, therefore it must not capture" rather than surfacing something that
// reads like a fault. The consequence is the important part: on an operating system where the
// notice cannot be shown, capture cannot start.
var ErrUnsupported = errors.New("notice: showing the monitoring notice is not supported on this operating system")

// unsupportedPresenter refuses to present. This file covers macOS and Linux, where the agent is
// developed and tested but does not capture (see internal/platform/platform_darwin.go for the
// reasoning: macOS support is product work, not a porting exercise).
type unsupportedPresenter struct{}

// NewPresenter returns a presenter that cannot show anything, together with ErrUnsupported.
//
// The value and the error are returned together on purpose, matching platform.New: a caller that
// logs the error and carries on gets something whose Present fails cleanly and reports "not
// accepted", rather than a nil interface that panics at the one moment the agent is deciding
// whether it is allowed to record anything.
func NewPresenter() (Presenter, error) {
	return unsupportedPresenter{}, ErrUnsupported
}

// Present always reports "not accepted", with ErrUnsupported.
func (unsupportedPresenter) Present(string) (bool, error) {
	return false, ErrUnsupported
}
