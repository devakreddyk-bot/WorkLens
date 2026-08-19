//go:build darwin

package platform

import (
	"errors"
	"testing"
)

// The darwin implementation is a deliberate non-implementation (see platform_darwin.go).
// This test pins the two properties the rest of the agent relies on while macOS support is
// unbuilt: every operation reports ErrUnsupported, and New never hands back a nil Platform
// that would panic on first use.
func TestDarwinPlatformReportsUnsupported(t *testing.T) {
	plat, err := New()
	if !errors.Is(err, ErrUnsupported) {
		t.Fatalf("New error = %v, want ErrUnsupported", err)
	}
	if plat == nil {
		t.Fatal("New returned a nil Platform; a caller that logs the error and continues would panic")
	}

	if _, err := plat.ActiveWindow(); !errors.Is(err, ErrUnsupported) {
		t.Errorf("ActiveWindow error = %v, want ErrUnsupported", err)
	}
	if _, err := plat.IdleDuration(); !errors.Is(err, ErrUnsupported) {
		t.Errorf("IdleDuration error = %v, want ErrUnsupported", err)
	}
	if _, err := plat.CaptureScreen(); !errors.Is(err, ErrUnsupported) {
		t.Errorf("CaptureScreen error = %v, want ErrUnsupported", err)
	}
	if err := plat.Close(); err != nil {
		t.Errorf("Close error = %v, want nil", err)
	}
}

// ErrNoActiveWindow must stay distinguishable from ErrUnsupported: the sampler treats the
// first as "record the interval with no attribution" and the second as "this OS cannot
// capture", and collapsing them would make a locked screen look like an unsupported machine.
func TestSentinelErrorsAreDistinct(t *testing.T) {
	if errors.Is(ErrNoActiveWindow, ErrUnsupported) || errors.Is(ErrUnsupported, ErrNoActiveWindow) {
		t.Fatal("the two sentinels must not match each other")
	}
}

func TestWindowInfoIsZero(t *testing.T) {
	if !(WindowInfo{}).IsZero() {
		t.Error("the zero WindowInfo must report IsZero")
	}
	// The shape an idle sample must never have.
	if (WindowInfo{WindowTitle: "Payroll - Google Chrome"}).IsZero() {
		t.Error("a WindowInfo carrying only a title must not report IsZero")
	}
}
