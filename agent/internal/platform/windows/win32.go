//go:build windows

// Package windows is the Win32 binding layer for the WorkLens agent: thin, single-purpose
// wrappers over the handful of system calls the agent needs, with every handle it opens
// closed on every path.
//
// It deliberately does not implement platform.Platform. The parent package's
// platform_windows.go composes these functions into that interface, which keeps the
// dependency arrow pointing one way (parent -> bindings, never back) and keeps this file
// free of any policy: it answers what the OS says, and nothing here decides what is worth
// recording.
//
// The complete list of system calls used by the agent is the list of wrappers in this
// file. There is no input-monitoring hook, no raw-input registration, no clipboard access,
// no camera and no audio device anywhere in it, and scripts/check-privacy.sh fails the
// build if that ever stops being true.
package windows

import (
	"errors"
	"fmt"
	"time"
	"unsafe"

	syswin "golang.org/x/sys/windows"
)

// The user32/kernel32 entry points that golang.org/x/sys/windows does not already wrap.
// NewLazySystemDLL resolves out of the system directory only, so a DLL of the same name
// dropped next to the binary cannot be loaded instead.
var (
	moduser32   = syswin.NewLazySystemDLL("user32.dll")
	modkernel32 = syswin.NewLazySystemDLL("kernel32.dll")

	procGetWindowTextW       = moduser32.NewProc("GetWindowTextW")
	procGetWindowTextLengthW = moduser32.NewProc("GetWindowTextLengthW")
	procGetLastInputInfo     = moduser32.NewProc("GetLastInputInfo")
	procGetTickCount64       = modkernel32.NewProc("GetTickCount64")
)

// ErrNoForegroundWindow reports that no window currently has focus. The parent package
// maps it onto platform.ErrNoActiveWindow. It is a normal state (locked workstation,
// desktop switch, an application that just exited), not a failure.
var ErrNoForegroundWindow = errors.New("windows: no foreground window")

// lastInputInfo mirrors Win32's LASTINPUTINFO. cbSize must be filled in by the caller —
// the API uses it as a version check and fails the call outright if it is wrong.
type lastInputInfo struct {
	cbSize uint32
	// dwTime is the value GetTickCount would have returned at the moment of the last
	// input event: milliseconds since boot, in 32 bits.
	dwTime uint32
}

// imageNameInitialChars is the first buffer size tried when reading an executable path.
// MAX_PATH (260) covers the overwhelming majority of installs; the retry loop grows to the
// 32,767-character NT limit for the long-path cases rather than silently truncating.
const (
	imageNameInitialChars = 320
	imageNameMaxChars     = 32768
)

// ForegroundWindow returns the handle of the window that currently has focus.
//
// A zero handle is not an error condition in the Win32 sense — no last-error is set — so
// it is translated into ErrNoForegroundWindow here rather than being handed upward as a
// handle the caller has to remember to check.
func ForegroundWindow() (syswin.HWND, error) {
	hwnd := syswin.GetForegroundWindow()
	if hwnd == 0 {
		return 0, ErrNoForegroundWindow
	}
	return hwnd, nil
}

// WindowTitle returns the caption of hwnd, or the empty string if it has none.
//
// The buffer is sized from GetWindowTextLengthW rather than assumed: a fixed 256-character
// buffer truncates real titles constantly (a browser tab title plus " - Google Chrome"
// passes 256 characters routinely, and the truncated remainder is exactly where the
// title-derived host would have been).
//
// The length and the text are two calls, so the title can change in between. That is
// benign: GetWindowTextW copies at most the buffer size and always NUL-terminates, so a
// title that grew between the calls is truncated, never overruns. A title that shrank
// simply yields a shorter string than the buffer allows for.
func WindowTitle(hwnd syswin.HWND) (string, error) {
	n, _, _ := procGetWindowTextLengthW.Call(uintptr(hwnd))
	length := int32(n)
	if length <= 0 {
		// Zero means "no caption" for the windows the agent sees (a caption-less tool
		// window, a splash screen). GetWindowTextLengthW does not distinguish that from a
		// failure, and treating an untitled window as an error would make the common case
		// look broken.
		return "", nil
	}

	buf := make([]uint16, length+1)
	copied, _, _ := procGetWindowTextW.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	if int32(copied) <= 0 {
		return "", nil
	}
	return syswin.UTF16ToString(buf[:copied]), nil
}

// WindowProcessImage returns the full path of the executable that owns hwnd.
//
// PROCESS_QUERY_LIMITED_INFORMATION is used rather than PROCESS_QUERY_INFORMATION for two
// reasons. It asks for strictly less — the right that grants image-name and exit-code
// queries, and nothing that would allow reading the process's memory — and it succeeds
// against more processes when the agent runs at normal integrity as a logged-on user,
// which is how it is deployed (docs/PLAN.md deviation D5). With the wider right, an
// elevated foreground application would report as an access-denied error and its time
// would go unattributed.
func WindowProcessImage(hwnd syswin.HWND) (string, error) {
	var pid uint32
	if _, err := syswin.GetWindowThreadProcessId(hwnd, &pid); err != nil {
		return "", fmt.Errorf("windows: GetWindowThreadProcessId: %w", err)
	}
	if pid == 0 {
		return "", ErrNoForegroundWindow
	}

	handle, err := syswin.OpenProcess(syswin.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return "", fmt.Errorf("windows: OpenProcess(pid=%d): %w", pid, err)
	}
	// One sample every sample_interval_seconds, forever: a handle leaked here is a handle
	// leaked every minute for the lifetime of the logon session, so the close is deferred
	// immediately after the successful open and before anything that can fail.
	defer syswin.CloseHandle(handle) //nolint:errcheck // nothing actionable on close failure

	for size := imageNameInitialChars; size <= imageNameMaxChars; size *= 2 {
		buf := make([]uint16, size)
		n := uint32(len(buf))
		err = syswin.QueryFullProcessImageName(handle, 0, &buf[0], &n)
		if err == nil {
			return syswin.UTF16ToString(buf[:n]), nil
		}
		if !errors.Is(err, syswin.ERROR_INSUFFICIENT_BUFFER) {
			return "", fmt.Errorf("windows: QueryFullProcessImageName(pid=%d): %w", pid, err)
		}
	}
	return "", fmt.Errorf("windows: QueryFullProcessImageName(pid=%d): path exceeds %d characters", pid, imageNameMaxChars)
}

// IdleDuration returns how long it has been since the last user input on this machine.
//
// This is the entire idle-detection mechanism in WorkLens. GetLastInputInfo hands back one
// number — the tick count at which the most recent input event arrived — and nothing else.
// It cannot report which key, which button, or which coordinates, so there is no content
// for the agent to discard or to accidentally keep.
//
// The correctness detail that matters: that tick count comes from GetTickCount, a 32-bit
// millisecond counter that wraps to zero roughly every 49.7 days of uptime. Two mistakes
// are easy here and both produce nonsense:
//
//   - Comparing it against a wall clock (time.Now) at all. The two count different things
//     from different epochs; the difference is meaningless, and a suspend/resume or an NTP
//     step makes it wildly wrong.
//   - Comparing it against GetTickCount64 in 64-bit arithmetic. After the first wrap the
//     32-bit dwTime restarts near zero while the 64-bit counter keeps climbing, so the
//     subtraction yields ~49.7 days of "idle" and every employee on a long-uptime laptop
//     is reported as permanently away.
//
// The fix is to take the delta in the same 32-bit domain the value came from. Truncating
// the 64-bit counter to uint32 and subtracting with unsigned wraparound gives the correct
// elapsed milliseconds across the wrap boundary, for any real idle interval — unsigned
// overflow is defined behaviour in Go, and the result is right as long as less than 49.7
// days have actually elapsed, which is guaranteed here because a sample is taken every
// minute.
//
// (GetTickCount64 rather than GetTickCount is used as the reference so that this reasoning
// stands even on a 32-bit build: the syscall return value is truncated to the low 32 bits
// on such a build, which is precisely the value the arithmetic below wants.)
func IdleDuration() (time.Duration, error) {
	info := lastInputInfo{}
	info.cbSize = uint32(unsafe.Sizeof(info))

	ret, _, callErr := procGetLastInputInfo.Call(uintptr(unsafe.Pointer(&info)))
	if ret == 0 {
		return 0, fmt.Errorf("windows: GetLastInputInfo: %w", callErr)
	}

	now, _, _ := procGetTickCount64.Call()
	elapsedMillis := uint32(now) - info.dwTime

	return time.Duration(elapsedMillis) * time.Millisecond, nil
}
