package logging

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// sink writes finished lines to stderr and to a size-capped file, rotating the file when it
// fills.
//
// Every path through it is failure-tolerant, and that is the whole design brief. This code runs
// inside a process whose job is to observe an employee's laptop: an antivirus scanner holding
// the file open, a full disk, a roaming profile that moved the directory out from under us, are
// all things that happen on real machines. None of them may stop the agent, and none of them
// may be reported on every line either — a logger that panics is a crash, and a logger that
// prints "rotation failed" 600 times an hour has destroyed the log it was meant to keep.
//
// The zero sink is valid and discards everything, which is what Discard uses.
type sink struct {
	mu   sync.Mutex
	path string

	maxBytes   int64
	maxBackups int

	stderr io.Writer
	file   *os.File
	size   int64

	// degraded records that a file-side failure has already been reported, so it is
	// mentioned once rather than on every subsequent line.
	degraded bool

	// lastOpenAttempt rate-limits reopening after a failure. time.Now is used directly
	// rather than the injected clock: this is a self-healing timer inside the failure path,
	// not behaviour a test needs to control, and tying it to a test clock would mean a test
	// that freezes time also freezes recovery.
	lastOpenAttempt time.Time

	// Injected so the rotation-failure path is testable without making the filesystem
	// misbehave. Production always uses the os functions.
	rename func(oldpath, newpath string) error
	remove func(name string) error
}

// reopenInterval is how long the sink waits before trying the file again after a failure.
const reopenInterval = time.Minute

func newSink(path string, maxBytes int64, maxBackups int, stderr io.Writer) (*sink, error) {
	s := &sink{
		path:       path,
		maxBytes:   maxBytes,
		maxBackups: maxBackups,
		stderr:     stderr,
		rename:     os.Rename,
		remove:     os.Remove,
	}
	if path == "" {
		return s, nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.openLocked(); err != nil {
		// Returned, not swallowed: the caller should say so on stderr. The sink stays usable
		// and keeps writing to stderr alone.
		return s, err
	}
	return s, nil
}

// Path reports the file being written, or "" for a stderr-only sink.
func (s *sink) Path() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.path
}

func (s *sink) openLocked() error {
	s.lastOpenAttempt = time.Now()

	if dir := filepath.Dir(s.path); dir != "" && dir != "." {
		// 0o700 for the same reason internal/store uses it: log lines carry app names,
		// error text and (in a debug build) window titles. On Windows the mode is advisory
		// and the installer sets the ACL, but there is no reason to be lax.
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("logging: could not create the log directory %q: %w", dir, err)
		}
	}

	file, err := os.OpenFile(s.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return fmt.Errorf("logging: could not open the log file %q: %w", s.path, err)
	}

	size := int64(0)
	if info, statErr := file.Stat(); statErr == nil {
		size = info.Size()
	}

	s.file = file
	s.size = size
	return nil
}

func (s *sink) write(line []byte) {
	if len(line) == 0 {
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	// stderr first, and unconditionally. If the file side is broken, this is the copy that
	// survives, so it must not be downstream of anything that can fail.
	if s.stderr != nil {
		_, _ = s.stderr.Write(line)
	}

	if s.path == "" {
		return
	}

	if s.file == nil {
		if time.Since(s.lastOpenAttempt) < reopenInterval {
			return
		}
		if err := s.openLocked(); err != nil {
			s.degradeLocked("file logging is unavailable", err)
			return
		}
		// Recovered. Say so, at most as often as reopenInterval allows.
		s.degraded = false
	}

	if s.maxBytes > 0 && s.size > 0 && s.size+int64(len(line)) > s.maxBytes {
		s.rotateLocked()
	}
	if s.file == nil {
		return
	}

	written, err := s.file.Write(line)
	s.size += int64(written)
	if err != nil {
		s.degradeLocked("could not write to the log file", err)
		_ = s.file.Close()
		s.file = nil
	}
}

// rotateLocked moves the active file aside and starts a new one.
//
// A failure here leaves the sink writing to whatever file it can still open — including the
// oversized original. That is the right trade: exceeding the cap by one file is a disk-space
// problem, whereas refusing to log because a rename failed is a blindness problem, and only
// one of the two can hide the reason an agent stopped working.
func (s *sink) rotateLocked() {
	if s.file != nil {
		_ = s.file.Close()
		s.file = nil
	}

	if err := s.shiftBackupsLocked(); err != nil {
		s.degradeLocked("could not rotate the log file", err)
		// Fall through and reopen anyway: appending to an over-cap file beats silence.
	}

	if err := s.openLocked(); err != nil {
		s.degradeLocked("could not reopen the log file after rotation", err)
		s.file = nil
	}
}

func (s *sink) shiftBackupsLocked() error {
	if s.maxBackups <= 0 {
		// Keeping no history means the active file is simply truncated. Removing it while it
		// is closed is the one operation that cannot leave a half-written line behind.
		if err := s.removeIfPresent(s.path); err != nil {
			return err
		}
		return nil
	}

	if err := s.removeIfPresent(backupPath(s.path, s.maxBackups)); err != nil {
		return err
	}
	for i := s.maxBackups - 1; i >= 1; i-- {
		from, to := backupPath(s.path, i), backupPath(s.path, i+1)
		if err := s.renameIfPresent(from, to); err != nil {
			return err
		}
	}
	return s.renameIfPresent(s.path, backupPath(s.path, 1))
}

// removeIfPresent and renameIfPresent treat a missing file as success: on the first rotation
// none of the backups exist yet, and that is not a fault.
func (s *sink) removeIfPresent(path string) error {
	if err := s.remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (s *sink) renameIfPresent(from, to string) error {
	if err := s.rename(from, to); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func backupPath(path string, index int) string {
	return path + "." + strconv.Itoa(index)
}

// degradeLocked reports a file-side failure to stderr once.
//
// Plain text, not JSON: this is the logger telling on itself, and a reader who is looking at
// the file that failed to be written needs the sentence, not a structured field.
func (s *sink) degradeLocked(what string, err error) {
	if s.degraded || s.stderr == nil {
		return
	}
	s.degraded = true
	_, _ = fmt.Fprintf(s.stderr,
		"logging: %s (%v) — continuing on stderr only; the agent is unaffected\n", what, err)
}

// Close releases the file. The sink stays usable afterwards and keeps writing to stderr, so a
// shutdown sequence that logs after Close still produces output.
func (s *sink) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.file == nil {
		return nil
	}
	err := s.file.Close()
	s.file = nil
	// Blanked so a later write does not append to a closed handle, and so it does not
	// immediately reopen either: Close means "stop using the file".
	s.path = ""
	return err
}
