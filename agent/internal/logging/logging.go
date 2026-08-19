// Package logging is the agent's structured logger: one JSON object per line, written to a
// size-capped rotating file on the laptop and to stderr.
//
// It is modelled on backend/src/shared/logger.ts, deliberately, so that a line from the agent
// and a line from a Lambda read the same way and answer the same questions. Two properties
// make it more than a wrapper around fmt.Fprintf, and both are the reason this package exists
// at all rather than the standard library's log/slog being used directly:
//
//  1. **Redaction is mandatory and there is no path around it.** Every value logged is walked
//     and anything whose key looks like a credential is replaced before it reaches a byte
//     buffer. A caller cannot log the device secret by accident, because there is no exported
//     function that writes a value without walking it first. In addition, literal secret
//     values registered with AddSecret are scrubbed out of every string — including out of
//     error messages, which is the one place key-based redaction cannot help, because
//     fmt.Errorf has already flattened the secret into prose by the time the logger sees it.
//
//  2. **Window titles are personal data, not diagnostics.** A title can name a document, a
//     client, a patient, a medical condition. `window_title`, `url_title` and `page_title` are
//     redacted unless IncludeTitles is explicitly set, which the agent never sets in
//     production. Titles are the most sensitive field WorkLens handles; a log file on the
//     employee's own laptop that quietly accumulated them would be a second, unmanaged copy of
//     the thing the product promises to handle carefully.
//
// # Logging must never take the agent down
//
// This logger observes the process; it is not allowed to kill it. Every failure below —
// the log directory being unwritable, a rotation losing a rename race with an antivirus
// scanner, the disk being full — degrades to "write to stderr and carry on" and is reported
// once rather than on every line. New returns a usable Logger even when it also returns an
// error, for the same reason internal/platform's darwin implementation does: a caller that
// logs the problem and continues must not be handed something that panics on first use.
package logging

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

// Level is a severity. The numeric values mirror LEVEL_ORDER in
// backend/src/shared/logger.ts so that the two halves of the system cannot disagree about
// what "warn or above" means.
type Level int32

// The four levels. Anything below the logger's current level is discarded before its fields
// are walked, so a debug call in a hot loop costs a comparison and nothing else.
const (
	LevelDebug Level = 10
	LevelInfo  Level = 20
	LevelWarn  Level = 30
	LevelError Level = 40

	// levelSilent is above every real level and is what Discard runs at. It is unexported
	// because a production agent must not be configurable into silence: an agent that logs
	// nothing cannot be told apart from one that has stopped working, which is the same
	// argument that makes the tray icon mandatory.
	levelSilent Level = 1 << 20
)

// String renders the level the way it appears in a log line.
func (l Level) String() string {
	switch l {
	case LevelDebug:
		return "debug"
	case LevelInfo:
		return "info"
	case LevelWarn:
		return "warn"
	case LevelError:
		return "error"
	case levelSilent:
		return "silent"
	default:
		return fmt.Sprintf("level(%d)", int32(l))
	}
}

// ParseLevel converts a configured string into a Level.
//
// An unrecognised value is an error rather than a silent fallback to info: a typo in a config
// file that quietly changes how much the agent records is exactly the kind of thing that is
// discovered months later, when the log that would have explained an incident turns out to
// have been at the wrong level all along.
func ParseLevel(value string) (Level, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "debug":
		return LevelDebug, nil
	case "info":
		return LevelInfo, nil
	case "warn", "warning":
		return LevelWarn, nil
	case "error":
		return LevelError, nil
	default:
		return LevelInfo, fmt.Errorf("logging: %q is not a level (debug, info, warn, error)", value)
	}
}

// Field is one key/value pair on a log line.
//
// Values are walked by the redactor before they are encoded, so any Go value is safe to pass:
// a struct with a Secret field, a map holding an Authorization header, a slice of samples with
// window titles in them. What comes out the other side has been filtered.
type Field struct {
	Key   string
	Value any
}

// Any attaches an arbitrary value. Prefer the typed constructors below where one fits; they
// exist so the common cases read cleanly at the call site, not because Any is unsafe.
func Any(key string, value any) Field { return Field{Key: key, Value: value} }

// String attaches a string.
func String(key, value string) Field { return Field{Key: key, Value: value} }

// Int attaches an int.
func Int(key string, value int) Field { return Field{Key: key, Value: int64(value)} }

// Int64 attaches an int64.
func Int64(key string, value int64) Field { return Field{Key: key, Value: value} }

// Bool attaches a bool.
func Bool(key string, value bool) Field { return Field{Key: key, Value: value} }

// Duration attaches a duration, rendered the way Go prints one ("1.5s", "2m30s") rather than
// as a bare number of nanoseconds nobody can read at a glance.
func Duration(key string, value time.Duration) Field { return Field{Key: key, Value: value} }

// Time attaches an instant, rendered as UTC RFC 3339.
func Time(key string, value time.Time) Field { return Field{Key: key, Value: value} }

// Err attaches an error under the conventional key "error". A nil error yields a field with a
// null value rather than being dropped, because "we got here with no error" is itself
// information when reading a line that also carries an outcome.
func Err(err error) Field { return Field{Key: "error", Value: err} }

// Reserved keys. A field using one of these is emitted with a trailing underscore rather than
// overwriting the line's own metadata, because a log line whose timestamp is whatever the
// caller happened to pass is worse than a slightly odd key name.
const (
	keyLevel     = "level"
	keyMessage   = "message"
	keyTimestamp = "timestamp"
)

// Options configures New.
type Options struct {
	// Path is the log file. An empty Path means stderr only, which is what tests and
	// `agentctl` subcommands use.
	Path string

	// MaxBytes caps the active file. Zero uses DefaultMaxBytes.
	MaxBytes int64

	// MaxBackups is how many rotated files to keep. Zero uses DefaultMaxBackups; a negative
	// value keeps none, truncating on rotation.
	MaxBackups int

	// Level is the initial level. Zero means LevelInfo.
	Level Level

	// IncludeTitles disables the redaction of window and page titles.
	//
	// This exists for local debugging of the sampler and the privacy filter, where the whole
	// question is which title was seen. The production agent never sets it, and nothing in
	// internal/config should offer a way to: see the package documentation.
	IncludeTitles bool

	// Secrets are literal values that must never appear in output, scrubbed from every
	// string the logger emits. The device secret belongs here, registered as soon as
	// credentials are loaded. Values shorter than MinSecretLength are ignored — scrubbing a
	// short common string would blank out unrelated text and make the log unreadable while
	// looking like it was working.
	Secrets []string

	// Stderr receives every line in addition to the file. Nil means os.Stderr; use
	// io.Discard to send nothing there.
	//
	// It is not nil-by-default because the agent is started by a Scheduled Task whose
	// stderr is captured, and because during enrolment a human is watching a console.
	Stderr io.Writer

	// Now is injected for tests. Nil means time.Now.
	Now func() time.Time
}

// Defaults sized for a log a human will actually read: a few weeks of an agent's ordinary
// chatter fits in the active file, and four files bound the total at 20 MiB on a laptop whose
// disk is not ours to fill.
const (
	DefaultMaxBytes   = 5 * 1024 * 1024
	DefaultMaxBackups = 3
)

// core is the state shared by a Logger and every child With returns. The level lives here, in
// one atomic, so that changing it at runtime takes effect for loggers that were already handed
// out — a config reload that raised the level but left the sampler's child logger at the old
// one would be a debugging trap.
type core struct {
	level         atomic.Int32
	sink          *sink
	redactor      *redactor
	includeTitles bool
	now           func() time.Time
}

// Logger writes structured lines. It is safe for concurrent use by any number of goroutines,
// which it has to be: the sampler, the uploader, the supervisor and the tray all log.
type Logger struct {
	core   *core
	fields []Field
}

// New builds a Logger.
//
// It returns a usable Logger even on error. A non-nil error means file logging could not be
// set up (an unwritable directory, most likely) and the returned Logger writes to stderr
// alone; the caller should report that and carry on rather than refuse to start, because
// "the agent would not run because it could not open its log file" is a worse outcome than
// "the agent ran and said so on stderr".
func New(opts Options) (*Logger, error) {
	if opts.MaxBytes <= 0 {
		opts.MaxBytes = DefaultMaxBytes
	}
	if opts.MaxBackups == 0 {
		opts.MaxBackups = DefaultMaxBackups
	}
	if opts.MaxBackups < 0 {
		opts.MaxBackups = 0
	}
	if opts.Level == 0 {
		opts.Level = LevelInfo
	}
	if opts.Stderr == nil {
		opts.Stderr = os.Stderr
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}

	red := newRedactor()
	for _, secret := range opts.Secrets {
		red.add(secret)
	}

	s, err := newSink(opts.Path, opts.MaxBytes, opts.MaxBackups, opts.Stderr)

	c := &core{
		sink:          s,
		redactor:      red,
		includeTitles: opts.IncludeTitles,
		now:           opts.Now,
	}
	c.level.Store(int32(opts.Level))

	return &Logger{core: c}, err
}

// Discard returns a Logger that writes nothing.
//
// Every package in the agent that takes a *Logger treats nil as "use this", so a caller can
// leave the field unset in a test without every call site needing a nil check. It is not a
// production configuration; see levelSilent.
func Discard() *Logger {
	c := &core{
		sink:     &sink{},
		redactor: newRedactor(),
		now:      time.Now,
	}
	c.level.Store(int32(levelSilent))
	return &Logger{core: c}
}

// OrDiscard returns l, or a discarding logger when l is nil. Packages use it in their
// constructors so that an optional logger costs one line and no nil checks afterwards.
func OrDiscard(l *Logger) *Logger {
	if l == nil {
		return Discard()
	}
	return l
}

// With returns a child logger that stamps every line with these fields.
//
// The child shares the parent's sink, level and secret registry; only the field set differs.
// The sampler binds its loop name, the uploader binds the batch's claim id, and a single
// grep then reconstructs one activity without every call site remembering to include it.
func (l *Logger) With(fields ...Field) *Logger {
	if len(fields) == 0 {
		return l
	}
	merged := make([]Field, 0, len(l.fields)+len(fields))
	merged = append(merged, l.fields...)
	merged = append(merged, fields...)
	return &Logger{core: l.core, fields: merged}
}

// SetLevel changes the level for this logger and every logger sharing its core, including
// children already handed out.
func (l *Logger) SetLevel(level Level) { l.core.level.Store(int32(level)) }

// Level reports the current level.
func (l *Logger) Level() Level { return Level(l.core.level.Load()) }

// Enabled reports whether a line at this level would be written. Worth checking only around
// genuinely expensive field construction; the logger already checks it itself.
func (l *Logger) Enabled(level Level) bool { return Level(l.core.level.Load()) <= level }

// AddSecret registers a literal value to be scrubbed from every subsequent line, at any
// nesting depth and inside error messages.
//
// Call it the moment a secret is loaded, before anything can log it. Values shorter than
// MinSecretLength are ignored and the return value says so, so a caller can tell the
// difference between "registered" and "silently did nothing".
func (l *Logger) AddSecret(secret string) bool { return l.core.redactor.add(secret) }

// Debug logs at debug level.
func (l *Logger) Debug(message string, fields ...Field) { l.write(LevelDebug, message, fields) }

// Info logs at info level.
func (l *Logger) Info(message string, fields ...Field) { l.write(LevelInfo, message, fields) }

// Warn logs at warn level.
func (l *Logger) Warn(message string, fields ...Field) { l.write(LevelWarn, message, fields) }

// Error logs at error level.
func (l *Logger) Error(message string, fields ...Field) { l.write(LevelError, message, fields) }

// Close releases the log file. Further writes go to stderr only rather than failing, so a
// shutdown path that logs after Close still produces output instead of losing the last thing
// the agent had to say.
func (l *Logger) Close() error { return l.core.sink.Close() }

// Path reports the file being written, or "" when this logger writes to stderr alone. The
// `agentctl doctor` output includes it, because "where is the log?" is the first question
// anyone asks.
func (l *Logger) Path() string { return l.core.sink.Path() }

func (l *Logger) write(level Level, message string, fields []Field) {
	if Level(l.core.level.Load()) > level {
		return
	}
	l.core.sink.write(l.core.encode(level, message, l.fields, fields))
}

// entry is one key/value pair on its way to the encoder, after redaction.
type entry struct {
	key   string
	value any
}

// encode renders one line, including the trailing newline.
//
// Values are walked and converted to plain Go types (string, float64, bool, map, slice, nil)
// before json.Marshal sees them. That is deliberate: a type with its own MarshalJSON could
// otherwise emit whatever it liked and walk straight past the redaction above it.
func (c *core) encode(level Level, message string, bound, extra []Field) []byte {
	entries := make([]entry, 0, len(bound)+len(extra))
	index := make(map[string]int, len(bound)+len(extra))

	add := func(f Field) {
		key := f.Key
		if key == "" {
			key = "field"
		}
		switch key {
		case keyLevel, keyMessage, keyTimestamp:
			key += "_"
		}

		value := c.redactField(f.Key, f.Value)
		if at, ok := index[key]; ok {
			// Last write wins, in the position of the first. A child logger's field and a
			// call-site field with the same name is a normal way to override context; two
			// copies of the key in one JSON object is not.
			entries[at].value = value
			return
		}
		index[key] = len(entries)
		entries = append(entries, entry{key: key, value: value})
	}

	for _, f := range bound {
		add(f)
	}
	for _, f := range extra {
		add(f)
	}

	var buf bytes.Buffer
	buf.Grow(128)
	buf.WriteByte('{')
	writeKV(&buf, keyLevel, level.String())
	buf.WriteByte(',')
	writeKV(&buf, keyMessage, c.redactor.scrubString(truncate(message)))
	buf.WriteByte(',')
	writeKV(&buf, keyTimestamp, c.now().UTC().Format(time.RFC3339Nano))
	for _, e := range entries {
		buf.WriteByte(',')
		writeKV(&buf, e.key, e.value)
	}
	buf.WriteString("}\n")

	// Last line of defence. Every string has already been scrubbed on the way in; doing it
	// once more over the finished bytes means a future encoding path that forgets to call
	// scrubString still cannot emit a registered secret.
	return c.redactor.scrubBytes(buf.Bytes())
}

// writeKV appends "key":value. Encoding failure is impossible for the plain values the
// redactor produces, but if it ever happened the field is replaced with a marker rather than
// the line being dropped: losing one field beats losing the message that names the problem.
func writeKV(buf *bytes.Buffer, key string, value any) {
	encoded, err := json.Marshal(key)
	if err != nil {
		encoded = []byte(`"?"`)
	}
	buf.Write(encoded)
	buf.WriteByte(':')

	encoded, err = json.Marshal(value)
	if err != nil {
		encoded = []byte(`"[unencodable]"`)
	}
	buf.Write(encoded)
}
