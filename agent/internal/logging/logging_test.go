package logging

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// The one thing this package must never do is leak a credential or a window title, so most of
// what follows is an attempt to get a known value out of it by every route a caller has: a
// field, a nested struct, a map, a slice, an error wrapped with %w, a stringly-typed value, a
// type with its own MarshalJSON.
//
// testSecret is what those attempts try to smuggle out. It is a plausible shape for a derived
// device secret (see D4 in docs/PLAN.md) and nothing else in the package refers to it.
const testSecret = "sk-live-3f9a2c8be14d47f0a6b25c7d9e0f1a2b"

// fixedTime keeps timestamps out of the way of the assertions.
func fixedTime() func() time.Time {
	instant := time.Date(2026, 3, 17, 9, 41, 2, 0, time.UTC)
	return func() time.Time { return instant }
}

func newTestLogger(t *testing.T, mutate func(*Options)) (*Logger, *bytes.Buffer) {
	t.Helper()

	var out bytes.Buffer
	opts := Options{
		Level:  LevelDebug,
		Stderr: &out,
		Now:    fixedTime(),
	}
	if mutate != nil {
		mutate(&opts)
	}

	logger, err := New(opts)
	if err != nil {
		t.Fatalf("New returned an error: %v", err)
	}
	t.Cleanup(func() { _ = logger.Close() })
	return logger, &out
}

// decodeLines parses the buffer into one map per line. It fails the test on any line that is
// not valid JSON, because a log a machine cannot parse is not a structured log.
func decodeLines(t *testing.T, out *bytes.Buffer) []map[string]any {
	t.Helper()

	var lines []map[string]any
	for _, raw := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		// The sink reports its own failures to stderr as plain prose, deliberately (see
		// degradeLocked). Those lines are not log records and are skipped here; anything
		// that looks like a record still has to parse.
		if !strings.HasPrefix(raw, "{") {
			continue
		}
		var line map[string]any
		if err := json.Unmarshal([]byte(raw), &line); err != nil {
			t.Fatalf("log line is not JSON: %v\nline: %s", err, raw)
		}
		lines = append(lines, line)
	}
	return lines
}

func requireNoSecret(t *testing.T, out *bytes.Buffer) {
	t.Helper()
	if bytes.Contains(out.Bytes(), []byte(testSecret)) {
		t.Fatalf("the secret reached the output:\n%s", out.String())
	}
	// A truncated secret is still a leak. Sixteen characters of a 36-character key is
	// plenty to brute-force the rest, so assert on a prefix too.
	if bytes.Contains(out.Bytes(), []byte(testSecret[:16])) {
		t.Fatalf("a prefix of the secret reached the output:\n%s", out.String())
	}
}

// ---------------------------------------------------------------------------
// Redaction — the reason this package exists
// ---------------------------------------------------------------------------

func TestRedactsCredentialKeys(t *testing.T) {
	logger, out := newTestLogger(t, nil)

	// Every spelling a caller might plausibly reach for. The point is that the key rules are
	// substring matches, so none of these needs to be enumerated anywhere.
	logger.Info("enrolling",
		String("device_secret", testSecret),
		String("deviceSecret", testSecret),
		String("DEVICE_SECRET_B64", testSecret),
		String("enrolment_token", testSecret),
		String("Authorization", "Bearer "+testSecret),
		String("X-WL-Signature", testSecret),
		String("apiKey", testSecret),
		String("password", testSecret),
		String("aws_credentials", testSecret),
		String("Cookie", "session="+testSecret),
	)

	requireNoSecret(t, out)

	line := decodeLines(t, out)[0]
	for key, value := range line {
		switch key {
		case keyLevel, keyMessage, keyTimestamp:
			continue
		}
		if value != redactedValue {
			t.Errorf("field %q was %v, want %q", key, value, redactedValue)
		}
	}
}

func TestRedactsNestedStructsMapsAndSlices(t *testing.T) {
	logger, out := newTestLogger(t, nil)

	type credentials struct {
		DeviceID     string `json:"device_id"`
		DeviceSecret string `json:"device_secret"`
		// Unexported fields are skipped entirely, so a secret kept private cannot escape
		// even by accident.
		internalToken string
	}
	type enrolment struct {
		Hostname    string
		Credentials credentials
		Headers     map[string]string
		History     []credentials
	}

	value := enrolment{
		Hostname: "WL-LAPTOP-07",
		Credentials: credentials{
			DeviceID:      "6b1f0c62-1f8e-4a9a-9a3f-1d2e3f4a5b6c",
			DeviceSecret:  testSecret,
			internalToken: testSecret,
		},
		Headers: map[string]string{
			"X-WL-Device":    "6b1f0c62",
			"X-WL-Signature": testSecret,
			"Authorization":  testSecret,
		},
		History: []credentials{{DeviceID: "older", DeviceSecret: testSecret}},
	}

	logger.Info("enrolment state", Any("enrolment", value), Any("pointer", &value))

	requireNoSecret(t, out)

	// The non-sensitive parts must survive: a redactor that flattened everything would be
	// safe and useless.
	if !strings.Contains(out.String(), "WL-LAPTOP-07") {
		t.Errorf("hostname was lost:\n%s", out.String())
	}
	if !strings.Contains(out.String(), "6b1f0c62") {
		t.Errorf("device id was lost:\n%s", out.String())
	}
}

func TestRedactsSecretInsideWrappedError(t *testing.T) {
	logger, out := newTestLogger(t, func(o *Options) { o.Secrets = []string{testSecret} })

	// The shape that key-based redaction cannot catch: by the time the logger sees this, the
	// secret is prose in the middle of a sentence. Registering the literal is the answer.
	inner := fmt.Errorf("signing failed with key %s", testSecret)
	middle := fmt.Errorf("uploading batch: %w", inner)
	outer := fmt.Errorf("agent: %w", middle)

	logger.Error("upload failed", Err(outer), Any("chain", []error{inner, middle, outer}))

	requireNoSecret(t, out)

	if !strings.Contains(out.String(), "uploading batch") {
		t.Errorf("the error message was lost entirely:\n%s", out.String())
	}
	if !errors.Is(outer, inner) {
		t.Fatal("test setup is wrong: the chain is not wrapped")
	}
}

func TestAddSecretAppliesToLaterLines(t *testing.T) {
	logger, out := newTestLogger(t, nil)

	if registered := logger.AddSecret(testSecret); !registered {
		t.Fatal("AddSecret refused a secret of usable length")
	}
	// Too short to scrub safely: doing so would blank out unrelated text.
	if registered := logger.AddSecret("abc"); registered {
		t.Error("AddSecret accepted a value below MinSecretLength")
	}

	logger.Info("device ready", String("detail", "token="+testSecret))
	requireNoSecret(t, out)
}

func TestMarshalJSONCannotBypassRedaction(t *testing.T) {
	logger, out := newTestLogger(t, nil)

	logger.Info("custom marshaller", Any("payload", leakyValue{Secret: testSecret}))

	requireNoSecret(t, out)
}

// leakyValue is a type whose own JSON encoding would publish its secret. The redactor walks
// values with reflection and never calls MarshalJSON, so this must not help.
type leakyValue struct {
	Secret string
}

func (l leakyValue) MarshalJSON() ([]byte, error) {
	return []byte(`{"secret":"` + l.Secret + `"}`), nil
}

func TestWindowTitlesAreRedactedByDefault(t *testing.T) {
	const title = "Payroll Q1 - Confidential.xlsx - Excel"

	logger, out := newTestLogger(t, nil)
	logger.Info("sample",
		String("window_title", title),
		String("WindowTitle", title),
		String("url_title", title),
		String("page_title", title),
		String("app_name", "excel.exe"),
	)

	if strings.Contains(out.String(), "Payroll") {
		t.Fatalf("a window title reached the log:\n%s", out.String())
	}
	if !strings.Contains(out.String(), "excel.exe") {
		t.Errorf("the application name should not be redacted:\n%s", out.String())
	}

	line := decodeLines(t, out)[0]
	if line["window_title"] != redactedPersonal {
		t.Errorf("window_title was %v, want %q", line["window_title"], redactedPersonal)
	}
}

func TestIncludeTitlesIsOptIn(t *testing.T) {
	const title = "sampler.go - worklens"

	logger, out := newTestLogger(t, func(o *Options) { o.IncludeTitles = true })
	logger.Debug("sample", String("window_title", title))

	if !strings.Contains(out.String(), title) {
		t.Errorf("IncludeTitles did not include the title:\n%s", out.String())
	}
}

func TestIncludeTitlesDoesNotIncludeSecrets(t *testing.T) {
	// The debugging escape hatch is for titles. It must not widen to credentials, or the
	// first person to turn it on gets a log file with the device secret in it.
	logger, out := newTestLogger(t, func(o *Options) { o.IncludeTitles = true })
	logger.Debug("sample", String("device_secret", testSecret), String("window_title", "x"))

	requireNoSecret(t, out)
}

func TestRedactsByteSlicesAndDepth(t *testing.T) {
	logger, out := newTestLogger(t, nil)

	logger.Info("bytes", Any("key_material", []byte(testSecret)))
	requireNoSecret(t, out)
	if !strings.Contains(out.String(), "bytes]") {
		t.Errorf("byte slices should be summarised by length:\n%s", out.String())
	}

	// A structure deeper than the cap terminates rather than recursing forever.
	type node struct {
		Name string
		Next *node
	}
	head := &node{Name: "0"}
	cursor := head
	for i := 1; i < 40; i++ {
		cursor.Next = &node{Name: fmt.Sprint(i)}
		cursor = cursor.Next
	}
	logger.Info("deep", Any("chain", head))
	if !strings.Contains(out.String(), "[max depth]") {
		t.Errorf("a deeply nested value should hit the depth cap:\n%s", out.String())
	}
}

func TestCyclicValueTerminates(t *testing.T) {
	logger, out := newTestLogger(t, nil)

	type ring struct {
		Name string
		Self *ring
	}
	value := &ring{Name: "loop"}
	value.Self = value

	logger.Info("cycle", Any("ring", value))

	if !strings.Contains(out.String(), "[circular]") {
		t.Errorf("a cycle should be reported, not followed:\n%s", out.String())
	}
}

func TestLongStringsAreTruncated(t *testing.T) {
	logger, out := newTestLogger(t, nil)
	logger.Info("long", String("detail", strings.Repeat("a", maxStringLength+500)))

	if !strings.Contains(out.String(), "truncated 500") {
		t.Errorf("a long value should be truncated:\n%s", out.String())
	}
}

// ---------------------------------------------------------------------------
// Line shape, levels and children
// ---------------------------------------------------------------------------

func TestLineShape(t *testing.T) {
	logger, out := newTestLogger(t, nil)
	logger.Warn("buffer is filling", Int64("buffered_events", 12_400), Duration("age", 90*time.Second))

	line := decodeLines(t, out)[0]
	if line[keyLevel] != "warn" {
		t.Errorf("level was %v", line[keyLevel])
	}
	if line[keyMessage] != "buffer is filling" {
		t.Errorf("message was %v", line[keyMessage])
	}
	if line[keyTimestamp] != "2026-03-17T09:41:02Z" {
		t.Errorf("timestamp was %v", line[keyTimestamp])
	}
	if line["buffered_events"] != float64(12_400) {
		t.Errorf("buffered_events was %v", line["buffered_events"])
	}
	if line["age"] != "1m30s" {
		t.Errorf("age was %v, want a human-readable duration", line["age"])
	}
}

func TestReservedKeysDoNotOverwriteLineMetadata(t *testing.T) {
	logger, out := newTestLogger(t, nil)
	logger.Info("real message", String("message", "impostor"), String("level", "trace"))

	line := decodeLines(t, out)[0]
	if line[keyMessage] != "real message" {
		t.Errorf("message was overwritten: %v", line[keyMessage])
	}
	if line["message_"] != "impostor" {
		t.Errorf("the caller's field was lost: %v", line["message_"])
	}
	if line[keyLevel] != "info" {
		t.Errorf("level was overwritten: %v", line[keyLevel])
	}
}

func TestLevelFiltering(t *testing.T) {
	logger, out := newTestLogger(t, func(o *Options) { o.Level = LevelWarn })

	logger.Debug("dropped")
	logger.Info("dropped")
	logger.Warn("kept")
	logger.Error("kept")

	if got := len(decodeLines(t, out)); got != 2 {
		t.Fatalf("wrote %d lines, want 2:\n%s", got, out.String())
	}
}

func TestSetLevelAffectsExistingChildren(t *testing.T) {
	logger, out := newTestLogger(t, func(o *Options) { o.Level = LevelInfo })
	child := logger.With(String("loop", "sampler"))

	child.Debug("not yet")
	if len(out.Bytes()) != 0 {
		t.Fatalf("debug was written at info level:\n%s", out.String())
	}

	// A config reload lowers the level on the parent. A child handed out earlier must follow,
	// or raising verbosity to diagnose the sampler would change nothing where it matters.
	logger.SetLevel(LevelDebug)
	child.Debug("now")

	lines := decodeLines(t, out)
	if len(lines) != 1 || lines[0]["loop"] != "sampler" {
		t.Fatalf("child did not pick up the new level:\n%s", out.String())
	}
}

func TestWithMergesFieldsAndLeavesTheParentAlone(t *testing.T) {
	logger, out := newTestLogger(t, nil)

	child := logger.With(String("loop", "uploader")).With(Int("attempt", 3))
	child.Info("retrying")
	logger.Info("parent")

	lines := decodeLines(t, out)
	if lines[0]["loop"] != "uploader" || lines[0]["attempt"] != float64(3) {
		t.Errorf("child fields missing: %v", lines[0])
	}
	if _, present := lines[1]["loop"]; present {
		t.Errorf("the parent picked up a child field: %v", lines[1])
	}
}

func TestCallSiteFieldOverridesBoundField(t *testing.T) {
	logger, out := newTestLogger(t, nil)

	logger.With(String("status", "monitoring")).Info("changed", String("status", "paused"))

	raw := out.String()
	if strings.Count(raw, `"status"`) != 1 {
		t.Errorf("the key appears more than once: %s", raw)
	}
	if decodeLines(t, out)[0]["status"] != "paused" {
		t.Errorf("the call-site value did not win: %s", raw)
	}
}

func TestParseLevel(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want Level
	}{
		{"debug", LevelDebug},
		{" INFO ", LevelInfo},
		{"warn", LevelWarn},
		{"warning", LevelWarn},
		{"error", LevelError},
	} {
		got, err := ParseLevel(tc.in)
		if err != nil {
			t.Errorf("ParseLevel(%q) errored: %v", tc.in, err)
		}
		if got != tc.want {
			t.Errorf("ParseLevel(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}

	if _, err := ParseLevel("trace"); err == nil {
		t.Error("an unknown level should be an error, not a silent default")
	}
}

func TestDiscardWritesNothing(t *testing.T) {
	logger := Discard()
	logger.Error("nobody hears this", String("device_secret", testSecret))

	if logger.Enabled(LevelError) {
		t.Error("Discard should report nothing as enabled")
	}
	if OrDiscard(nil) == nil {
		t.Error("OrDiscard(nil) must return a usable logger")
	}
	if OrDiscard(logger) != logger {
		t.Error("OrDiscard should pass a real logger through")
	}
}

func TestConcurrentUseIsSafe(t *testing.T) {
	logger, out := newTestLogger(t, nil)

	var wg sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			child := logger.With(Int("worker", worker))
			for i := 0; i < 50; i++ {
				child.Info("tick", Int("i", i), String("device_secret", testSecret))
				logger.SetLevel(LevelDebug)
			}
		}(worker)
	}
	wg.Wait()

	requireNoSecret(t, out)
	if got := len(decodeLines(t, out)); got != 8*50 {
		t.Errorf("wrote %d lines, want %d", got, 8*50)
	}
}

// ---------------------------------------------------------------------------
// The file side: rotation, and degrading rather than crashing
// ---------------------------------------------------------------------------

func TestWritesToFileAndStderr(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "logs", "worklens.log")

	logger, out := newTestLogger(t, func(o *Options) { o.Path = path })
	logger.Info("hello", String("device_secret", testSecret))

	if logger.Path() != path {
		t.Errorf("Path() = %q, want %q", logger.Path(), path)
	}

	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading the log file: %v", err)
	}
	if !bytes.Contains(contents, []byte(`"message":"hello"`)) {
		t.Errorf("the file is missing the line: %s", contents)
	}
	if bytes.Contains(contents, []byte(testSecret)) {
		t.Errorf("the secret reached the file: %s", contents)
	}
	if !strings.Contains(out.String(), `"message":"hello"`) {
		t.Errorf("stderr is missing the line: %s", out.String())
	}
}

func TestRotationKeepsAtMostMaxBackups(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "worklens.log")

	logger, _ := newTestLogger(t, func(o *Options) {
		o.Path = path
		o.MaxBytes = 300
		o.MaxBackups = 2
		o.Stderr = io.Discard // exercise the file-only configuration
	})

	for i := 0; i < 60; i++ {
		logger.Info("filling the file up", Int("i", i), String("padding", strings.Repeat("x", 60)))
	}

	for _, name := range []string{"worklens.log", "worklens.log.1", "worklens.log.2"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Errorf("expected %s to exist: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "worklens.log.3")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("worklens.log.3 should have been dropped, got %v", err)
	}

	// The cap is a cap: the active file must not have grown past it by more than one line.
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Size() > 300+400 {
		t.Errorf("the active file is %d bytes, well past the 300-byte cap", info.Size())
	}
}

func TestRotationFailureDoesNotStopLogging(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "worklens.log")

	var out bytes.Buffer
	logger, err := New(Options{Path: path, MaxBytes: 200, MaxBackups: 2, Level: LevelDebug, Stderr: &out, Now: fixedTime()})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = logger.Close() })

	// Injected rather than provoked with filesystem permissions: rotation fails on real
	// machines because something else holds the file open, and a test that chmods a directory
	// proves less and flakes more.
	failures := 0
	logger.core.sink.mu.Lock()
	logger.core.sink.rename = func(string, string) error {
		failures++
		return errors.New("rename refused by another process")
	}
	logger.core.sink.mu.Unlock()

	for i := 0; i < 40; i++ {
		logger.Info("still going", Int("i", i), String("padding", strings.Repeat("y", 40)))
	}

	if failures == 0 {
		t.Fatal("the test never reached the rotation path")
	}
	if got := len(decodeLines(t, &out)); got < 40 {
		t.Errorf("lost lines to a rotation failure: got %d of 40", got)
	}
	if !strings.Contains(out.String(), "could not rotate the log file") {
		t.Error("the failure should be reported once on stderr")
	}
	if strings.Count(out.String(), "could not rotate the log file") != 1 {
		t.Errorf("the failure was reported %d times, want once",
			strings.Count(out.String(), "could not rotate the log file"))
	}
}

func TestUnwritablePathStillReturnsAUsableLogger(t *testing.T) {
	// A file path underneath an existing *file* cannot be created, on every OS.
	blocker := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatalf("writing the blocker: %v", err)
	}

	var out bytes.Buffer
	logger, err := New(Options{Path: filepath.Join(blocker, "worklens.log"), Stderr: &out, Now: fixedTime()})
	if err == nil {
		t.Fatal("New should report that the log file could not be opened")
	}
	if logger == nil {
		t.Fatal("New must return a usable logger even when it reports an error")
	}
	t.Cleanup(func() { _ = logger.Close() })

	logger.Info("the agent is running anyway")
	if !strings.Contains(out.String(), "the agent is running anyway") {
		t.Errorf("stderr should still receive lines:\n%s", out.String())
	}
}

func TestLoggingAfterCloseGoesToStderr(t *testing.T) {
	path := filepath.Join(t.TempDir(), "worklens.log")
	logger, out := newTestLogger(t, func(o *Options) { o.Path = path })

	if err := logger.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	logger.Info("shutting down")

	if !strings.Contains(out.String(), "shutting down") {
		t.Errorf("a line logged after Close was lost:\n%s", out.String())
	}
}
