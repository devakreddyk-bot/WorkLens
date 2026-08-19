//go:build !windows

package tray

// newPlatformController on a non-Windows build.
//
// It returns a Headless controller **and** an error, and both matter. The error is what stops a
// production Windows build from ever reaching here silently; the usable controller means a
// developer on macOS running the agent for a smoke test gets something that works rather than a
// nil dereference.
//
// The agent's main() treats the error as fatal on Windows and logs it as a warning elsewhere,
// which is the only place that distinction is made — see cmd/worklens-agent.
func newPlatformController(callbacks Callbacks) (Controller, error) {
	return NewHeadless(callbacks), &ErrUnavailable{
		Reason: "the system tray is only implemented on Windows; this build has no visible indicator",
	}
}
