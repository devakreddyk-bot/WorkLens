// Package store is the agent's local buffer.
//
// Everything the agent captures lands here first and is deleted only after the server has
// acknowledged it. That ordering is what makes the agent survive a train tunnel, a hotel
// captive portal, a laptop closed mid-upload, and a backend deploy.
//
// # Why SQLite, and why this driver
//
// A file of JSON lines would be simpler until the first partially-written record, or the first
// need to delete exactly the rows the server accepted. SQLite gives durable transactions and
// delete-by-id for free.
//
// The driver is modernc.org/sqlite — a pure-Go translation, not a cgo binding. That is not a
// stylistic preference: the agent must build with CGO_ENABLED=0 to cross-compile from a
// developer's Mac or a Linux CI runner into a single static Windows binary. mattn/go-sqlite3
// would put a Windows C toolchain in the build path and break that entirely.
//
// # The claim protocol
//
// Uploading is not "read rows, send, delete". A crash between send and delete resends
// everything; a crash between read and send blocks forever behind rows nobody owns. Instead
// each attempt *claims* rows by stamping them with a claim id and a timestamp:
//
//	AppendEvent  → claimed_by IS NULL
//	ClaimBatch   → claimed_by = <id>, claimed_at = now
//	DeleteBatch  → rows gone, after a 2xx
//	ReleaseBatch → claimed_by = NULL, after a retryable failure
//	Recover      → releases claims older than the stale threshold, at startup
//
// The server deduplicates on (device_id, client_event_id), so a double send is free. This
// protocol exists to stop rows being *lost* or *stuck*, not to prevent duplicates — that
// guarantee lives on the server, the only place it can actually be enforced.
//
// # The cap
//
// An agent offline for a month must not fill the disk. Over the cap, the OLDEST events are
// dropped and the caller records an agent_health event with the count, so a gap in a timesheet
// is always explainable. Dropping the newest would be easier and wrong: recent activity is
// most of what a timesheet is about.
package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite" // registers the "sqlite" driver
)

// EventType mirrors the server's activity_events.event_type CHECK constraint. A value outside
// this set is rejected at the far end, so it is validated here rather than discovered when an
// upload fails.
type EventType string

const (
	EventWindowSample EventType = "window_sample"
	EventIdleState    EventType = "idle_state"
	EventSessionStart EventType = "session_start"
	EventSessionEnd   EventType = "session_end"
	EventNoticeAck    EventType = "notice_ack"
	EventAgentHealth  EventType = "agent_health"
)

var validEventTypes = map[EventType]struct{}{
	EventWindowSample: {}, EventIdleState: {}, EventSessionStart: {},
	EventSessionEnd: {}, EventNoticeAck: {}, EventAgentHealth: {},
}

// MaxDurationSeconds matches the server's CHECK (duration_seconds between 0 and 3600). Longer
// means a stalled clock or a resume from sleep, not a real work span.
const MaxDurationSeconds = 3600

// Event is one buffered activity sample, in the shape the ingest API accepts.
type Event struct {
	// ClientEventID is the idempotency key, generated on the agent so that a resend after a
	// timeout is recognised as the same event rather than double-counted.
	ClientEventID string
	Type          EventType
	CapturedAt    time.Time
	Duration      time.Duration
	IsIdle        bool

	AppName     string
	AppExe      string
	WindowTitle string
	URLHost     string
	URLTitle    string

	// Detail carries structured context for agent_health events (a dropped-event count, a
	// capture error). Empty for ordinary samples.
	Detail string
}

// Validate checks an event against the constraints the server will apply.
//
// Rejecting locally is strictly better than uploading and being rejected: the ingest endpoint
// fails a whole batch on one bad event, so one malformed sample would discard every good event
// batched with it.
func (e Event) Validate() error {
	if _, ok := validEventTypes[e.Type]; !ok {
		return fmt.Errorf("store: %q is not a valid event type", e.Type)
	}
	if e.CapturedAt.IsZero() {
		return errors.New("store: event has no captured_at")
	}

	seconds := int64(e.Duration.Seconds())
	if seconds < 0 || seconds > MaxDurationSeconds {
		return fmt.Errorf("store: duration %ds is outside the accepted range 0-%d",
			seconds, MaxDurationSeconds)
	}

	// The server's activity_events_idle_no_attribution_chk rejects the batch if an idle event
	// carries attribution. The privacy filter strips it; this is the belt to that braces,
	// because the cost of one slipping through is losing an entire batch.
	if e.IsIdle {
		if e.AppName != "" || e.AppExe != "" || e.WindowTitle != "" || e.URLHost != "" || e.URLTitle != "" {
			return errors.New(
				"store: an idle event must carry no application, title or host — the server " +
					"rejects the whole batch otherwise")
		}
	}

	return nil
}

// Screenshot is one queued image awaiting upload.
//
// The bytes live on disk beside the database rather than inside it: a 200 KB blob per row would
// bloat the file and make the cap arithmetic meaningless, and the uploader streams the file
// straight to S3 without it ever passing through the database.
type Screenshot struct {
	ID         int64
	CapturedAt time.Time
	Path       string
	Width      int
	Height     int
	ByteCount  int64
	SHA256     string
	Blurred    bool
}

// Options configures a Store.
type Options struct {
	// MaxBytes caps the buffered event volume. Zero uses DefaultMaxBytes.
	MaxBytes int64
	// MaxAge drops events older than this regardless of size: a month-old sample has no value
	// on a timesheet that was signed off weeks ago.
	MaxAge time.Duration
	// StaleClaimAfter is how long a claim may sit before Recover releases it. Must exceed the
	// longest plausible upload, or a slow upload has its rows released and resent underneath it.
	StaleClaimAfter time.Duration
	// Now is injected for tests. Defaults to time.Now.
	Now func() time.Time
}

// Defaults chosen so a fortnight offline loses nothing and no disk is ever filled.
const (
	DefaultMaxBytes        = 250 * 1024 * 1024
	DefaultMaxAge          = 14 * 24 * time.Hour
	DefaultStaleClaimAfter = 15 * time.Minute
)

func (o Options) withDefaults() Options {
	if o.MaxBytes <= 0 {
		o.MaxBytes = DefaultMaxBytes
	}
	if o.MaxAge <= 0 {
		o.MaxAge = DefaultMaxAge
	}
	if o.StaleClaimAfter <= 0 {
		o.StaleClaimAfter = DefaultStaleClaimAfter
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	return o
}

// Store is the buffer. Safe for concurrent use: the sampler, the screenshotter and the
// uploader all touch it from different goroutines.
type Store struct {
	db   *sql.DB
	opts Options
	path string
}

// Open creates or opens the buffer at path and applies the local schema.
func Open(path string, opts Options) (*Store, error) {
	opts = opts.withDefaults()

	if dir := filepath.Dir(path); dir != "" && dir != "." {
		// 0o700 because the buffer holds window titles, which are personal data. On Windows the
		// mode is advisory and the installer sets the ACL, but there is no reason to be lax.
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, fmt.Errorf("store: could not create %s: %w", dir, err)
		}
	}

	// WAL so a reader never blocks the sampler's writes; busy_timeout so a brief lock is waited
	// out rather than surfaced as an error every caller has to handle.
	dsn := "file:" + path +
		"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)"

	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("store: could not open %s: %w", path, err)
	}

	// SQLite tolerates one writer. Capping the pool at one connection turns lock contention
	// into an in-process queue instead of SQLITE_BUSY errors scattered across call sites.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	s := &Store{db: db, opts: opts, path: path}

	if err := s.migrate(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}

	return s, nil
}

// Close releases the database.
func (s *Store) Close() error {
	if s.db == nil {
		return nil
	}
	return s.db.Close()
}

// Path returns the database file location, for diagnostics.
func (s *Store) Path() string { return s.path }

// migrate applies the local schema.
//
// Deliberately simpler than the server's forward-only ledger: this database is local,
// disposable and recreated on enrolment, so CREATE TABLE IF NOT EXISTS plus user_version is
// enough. Losing it costs at most the unsent buffer, never history.
func (s *Store) migrate(ctx context.Context) error {
	const schema = `
create table if not exists events (
    id               integer primary key autoincrement,
    client_event_id  text    not null unique,
    event_type       text    not null,
    captured_at      text    not null,
    duration_seconds integer not null,
    is_idle          integer not null,
    app_name         text,
    app_exe          text,
    window_title     text,
    url_host         text,
    url_title        text,
    detail           text,
    byte_estimate    integer not null,
    claimed_by       text,
    claimed_at       text,
    created_at       text    not null
);

create index if not exists events_unclaimed_idx on events (id) where claimed_by is null;
create index if not exists events_claimed_idx on events (claimed_at) where claimed_by is not null;
create index if not exists events_captured_idx on events (captured_at);

create table if not exists screenshots (
    id          integer primary key autoincrement,
    captured_at text    not null,
    path        text    not null unique,
    width       integer not null,
    height      integer not null,
    byte_count  integer not null,
    sha256      text    not null,
    blurred     integer not null,
    claimed_by  text,
    claimed_at  text,
    created_at  text    not null
);

create index if not exists screenshots_unclaimed_idx on screenshots (id) where claimed_by is null;

create table if not exists meta (
    key        text primary key,
    value      text not null,
    updated_at text not null
);
`

	if _, err := s.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("store: could not apply the local schema: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, "pragma user_version = 1"); err != nil {
		return fmt.Errorf("store: could not set user_version: %w", err)
	}
	return nil
}

// Timestamps are RFC3339 with nanoseconds, in UTC. Text so the file is legible when the only
// diagnostic available is opening the database on a user's laptop; UTC so changing the machine's
// timezone cannot reorder rows.
const timeLayout = time.RFC3339Nano

func formatTime(t time.Time) string { return t.UTC().Format(timeLayout) }

func parseTime(value string) (time.Time, error) { return time.Parse(timeLayout, value) }

func newClaimID() (string, error) {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("store: could not generate a claim id: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

// NewClientEventID returns a UUIDv4 for use as an idempotency key.
//
// Hand-rolled rather than adding a UUID dependency for one function; the agent's dependency
// list is deliberately short because every entry is code that ships to an employee's laptop.
func NewClientEventID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("store: could not generate a client event id: %w", err)
	}
	buf[6] = (buf[6] & 0x0f) | 0x40 // version 4
	buf[8] = (buf[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x", buf[0:4], buf[4:6], buf[6:8], buf[8:10], buf[10:16]), nil
}

// estimateBytes approximates an event's serialised size, used for the cap.
//
// An approximation deliberately: the exact figure depends on the uploader's JSON encoding, and
// measuring the real file size on every insert would cost a pragma round trip per sample. The
// constant covers the fixed per-event scaffolding.
func estimateBytes(e Event) int64 {
	const overhead = 220
	return int64(overhead + len(e.ClientEventID) + len(e.AppName) + len(e.AppExe) +
		len(e.WindowTitle) + len(e.URLHost) + len(e.URLTitle) + len(e.Detail))
}

// AppendEvent buffers one event, assigning a client event id if it has none.
func (s *Store) AppendEvent(ctx context.Context, e Event) (string, error) {
	if err := e.Validate(); err != nil {
		return "", err
	}

	if e.ClientEventID == "" {
		id, err := NewClientEventID()
		if err != nil {
			return "", err
		}
		e.ClientEventID = id
	}

	_, err := s.db.ExecContext(ctx, `
        insert into events (
            client_event_id, event_type, captured_at, duration_seconds, is_idle,
            app_name, app_exe, window_title, url_host, url_title, detail,
            byte_estimate, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		e.ClientEventID, string(e.Type), formatTime(e.CapturedAt),
		int64(e.Duration.Seconds()), boolToInt(e.IsIdle),
		nullable(e.AppName), nullable(e.AppExe), nullable(e.WindowTitle),
		nullable(e.URLHost), nullable(e.URLTitle), nullable(e.Detail),
		estimateBytes(e), formatTime(s.opts.Now()),
	)
	if err != nil {
		return "", fmt.Errorf("store: could not buffer an event: %w", err)
	}

	return e.ClientEventID, nil
}

// Batch is a claimed set of events, ready to upload.
type Batch struct {
	// ClaimID identifies this claim. Pass it to DeleteBatch or ReleaseBatch.
	ClaimID string
	IDs     []int64
	Events  []Event
}

// Empty reports whether there was nothing to send.
func (b Batch) Empty() bool { return len(b.Events) == 0 }

// ClaimBatch takes up to max unclaimed events, oldest first, and marks them claimed.
//
// Oldest first so a long offline period drains chronologically and a timesheet fills in order
// rather than arriving scrambled.
func (s *Store) ClaimBatch(ctx context.Context, max int) (Batch, error) {
	if max <= 0 {
		return Batch{}, fmt.Errorf("store: batch size must be positive, got %d", max)
	}

	claimID, err := newClaimID()
	if err != nil {
		return Batch{}, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Batch{}, fmt.Errorf("store: could not begin a claim: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// Claim and read in one transaction. Selecting first and updating after would let two
	// uploader goroutines claim the same rows.
	if _, err := tx.ExecContext(ctx, `
        update events set claimed_by = ?, claimed_at = ?
         where id in (select id from events where claimed_by is null order by id limit ?)`,
		claimID, formatTime(s.opts.Now()), max); err != nil {
		return Batch{}, fmt.Errorf("store: could not claim events: %w", err)
	}

	batch, err := scanBatch(ctx, tx, claimID)
	if err != nil {
		return Batch{}, err
	}

	if err := tx.Commit(); err != nil {
		return Batch{}, fmt.Errorf("store: could not commit a claim: %w", err)
	}

	return batch, nil
}

func scanBatch(ctx context.Context, tx *sql.Tx, claimID string) (Batch, error) {
	rows, err := tx.QueryContext(ctx, `
        select id, client_event_id, event_type, captured_at, duration_seconds, is_idle,
               coalesce(app_name, ''), coalesce(app_exe, ''), coalesce(window_title, ''),
               coalesce(url_host, ''), coalesce(url_title, ''), coalesce(detail, '')
          from events where claimed_by = ? order by id`, claimID)
	if err != nil {
		return Batch{}, fmt.Errorf("store: could not read the claimed batch: %w", err)
	}
	defer func() { _ = rows.Close() }()

	batch := Batch{ClaimID: claimID}
	for rows.Next() {
		var (
			id              int64
			eventType       string
			capturedAt      string
			durationSeconds int64
			isIdle          int
			e               Event
		)
		if err := rows.Scan(&id, &e.ClientEventID, &eventType, &capturedAt, &durationSeconds,
			&isIdle, &e.AppName, &e.AppExe, &e.WindowTitle, &e.URLHost, &e.URLTitle, &e.Detail); err != nil {
			return Batch{}, fmt.Errorf("store: could not scan a claimed event: %w", err)
		}

		parsed, err := parseTime(capturedAt)
		if err != nil {
			return Batch{}, fmt.Errorf("store: event %d has an unparseable captured_at %q: %w", id, capturedAt, err)
		}

		e.Type = EventType(eventType)
		e.CapturedAt = parsed
		e.Duration = time.Duration(durationSeconds) * time.Second
		e.IsIdle = isIdle != 0

		batch.IDs = append(batch.IDs, id)
		batch.Events = append(batch.Events, e)
	}
	if err := rows.Err(); err != nil {
		return Batch{}, fmt.Errorf("store: could not iterate the claimed batch: %w", err)
	}
	return batch, nil
}

// DeleteBatch removes a claimed batch. Called only after the server has accepted it.
func (s *Store) DeleteBatch(ctx context.Context, claimID string) (int64, error) {
	return s.affecting(ctx, `delete from events where claimed_by = ?`, claimID,
		"could not delete an uploaded batch")
}

// ReleaseBatch unclaims a batch after a retryable failure, so the next attempt picks it up.
func (s *Store) ReleaseBatch(ctx context.Context, claimID string) (int64, error) {
	return s.affecting(ctx,
		`update events set claimed_by = null, claimed_at = null where claimed_by = ?`, claimID,
		"could not release a batch")
}

// ReleaseScreenshots unclaims a screenshot batch after a retryable failure.
func (s *Store) ReleaseScreenshots(ctx context.Context, claimID string) (int64, error) {
	return s.affecting(ctx,
		`update screenshots set claimed_by = null, claimed_at = null where claimed_by = ?`, claimID,
		"could not release screenshots")
}

func (s *Store) affecting(ctx context.Context, query, arg, what string) (int64, error) {
	result, err := s.db.ExecContext(ctx, query, arg)
	if err != nil {
		return 0, fmt.Errorf("store: %s: %w", what, err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("store: %s (counting rows): %w", what, err)
	}
	return affected, nil
}

// Recover releases claims left behind by a crash. Called once at startup.
//
// Without it, a process killed mid-upload leaves rows claimed forever: the buffer grows while
// appearing to have nothing to send, which is the most confusing failure this package can have.
func (s *Store) Recover(ctx context.Context) (events int64, screenshots int64, err error) {
	cutoff := formatTime(s.opts.Now().Add(-s.opts.StaleClaimAfter))

	events, err = s.affecting(ctx,
		`update events set claimed_by = null, claimed_at = null
          where claimed_by is not null and claimed_at < ?`, cutoff,
		"could not recover stale event claims")
	if err != nil {
		return 0, 0, err
	}

	screenshots, err = s.affecting(ctx,
		`update screenshots set claimed_by = null, claimed_at = null
          where claimed_by is not null and claimed_at < ?`, cutoff,
		"could not recover stale screenshot claims")
	if err != nil {
		return events, 0, err
	}

	return events, screenshots, nil
}

// Stats describes the buffer, for the tray tooltip and agentctl doctor.
type Stats struct {
	Events           int64
	ClaimedEvents    int64
	Screenshots      int64
	EstimatedBytes   int64
	FileBytes        int64
	OldestCapturedAt time.Time
}

// Stats reads the buffer's current state.
func (s *Store) Stats(ctx context.Context) (Stats, error) {
	var stats Stats
	var oldest sql.NullString

	err := s.db.QueryRowContext(ctx, `
        select count(*),
               coalesce(sum(case when claimed_by is not null then 1 else 0 end), 0),
               coalesce(sum(byte_estimate), 0),
               min(captured_at)
          from events`).Scan(&stats.Events, &stats.ClaimedEvents, &stats.EstimatedBytes, &oldest)
	if err != nil {
		return stats, fmt.Errorf("store: could not read event statistics: %w", err)
	}

	if oldest.Valid {
		if parsed, perr := parseTime(oldest.String); perr == nil {
			stats.OldestCapturedAt = parsed
		}
	}

	if err := s.db.QueryRowContext(ctx, `select count(*) from screenshots`).Scan(&stats.Screenshots); err != nil {
		return stats, fmt.Errorf("store: could not count screenshots: %w", err)
	}

	if info, statErr := os.Stat(s.path); statErr == nil {
		stats.FileBytes = info.Size()
	}

	return stats, nil
}

// EnforceCap drops the oldest events when the buffer exceeds its limits.
//
// Returns the counts. The caller records an agent_health event with them — the store does not
// write that itself, because doing so would make a cap sweep insert a row and could recurse
// into another sweep. Keeping the two separate leaves the reporting decision with the caller
// that knows why the sweep happened.
func (s *Store) EnforceCap(ctx context.Context) (droppedByAge int64, droppedByCap int64, err error) {
	// Claimed rows are excluded throughout: an upload in flight must not have its rows deleted
	// from underneath it.
	ageCutoff := formatTime(s.opts.Now().Add(-s.opts.MaxAge))
	droppedByAge, err = s.affecting(ctx,
		`delete from events where claimed_by is null and captured_at < ?`, ageCutoff,
		"could not drop aged-out events")
	if err != nil {
		return 0, 0, err
	}

	var estimated int64
	if err := s.db.QueryRowContext(ctx,
		`select coalesce(sum(byte_estimate), 0) from events`).Scan(&estimated); err != nil {
		return droppedByAge, 0, fmt.Errorf("store: could not measure the buffer: %w", err)
	}

	if estimated <= s.opts.MaxBytes {
		return droppedByAge, 0, nil
	}

	// Over the cap: delete oldest-first until back under it, in one statement using a running
	// total rather than a loop of round trips. Ordering by captured_at then id means a clock
	// adjustment cannot strand old rows behind newer ones.
	excess := estimated - s.opts.MaxBytes
	result, err := s.db.ExecContext(ctx, `
        delete from events where id in (
            select id from (
                select id, sum(byte_estimate) over (order by captured_at, id) as running
                  from events where claimed_by is null
            ) where running <= ?
        )`, excess)
	if err != nil {
		return droppedByAge, 0, fmt.Errorf("store: could not drop events over the cap: %w", err)
	}
	if droppedByCap, err = result.RowsAffected(); err != nil {
		return droppedByAge, 0, fmt.Errorf("store: could not count events dropped over the cap: %w", err)
	}

	return droppedByAge, droppedByCap, nil
}

// EnqueueScreenshot records a captured image awaiting upload.
func (s *Store) EnqueueScreenshot(ctx context.Context, shot Screenshot) (int64, error) {
	if shot.Path == "" {
		return 0, errors.New("store: a screenshot needs a file path")
	}
	if shot.CapturedAt.IsZero() {
		return 0, errors.New("store: a screenshot needs a captured_at")
	}

	result, err := s.db.ExecContext(ctx, `
        insert into screenshots (captured_at, path, width, height, byte_count, sha256, blurred, created_at)
        values (?, ?, ?, ?, ?, ?, ?, ?)`,
		formatTime(shot.CapturedAt), shot.Path, shot.Width, shot.Height,
		shot.ByteCount, shot.SHA256, boolToInt(shot.Blurred), formatTime(s.opts.Now()))
	if err != nil {
		return 0, fmt.Errorf("store: could not queue a screenshot: %w", err)
	}

	id, err := result.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("store: could not read the queued screenshot's id: %w", err)
	}
	return id, nil
}

// ClaimScreenshots takes up to max unclaimed screenshots, oldest first.
func (s *Store) ClaimScreenshots(ctx context.Context, max int) (string, []Screenshot, error) {
	if max <= 0 {
		return "", nil, fmt.Errorf("store: batch size must be positive, got %d", max)
	}

	claimID, err := newClaimID()
	if err != nil {
		return "", nil, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", nil, fmt.Errorf("store: could not begin a screenshot claim: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, `
        update screenshots set claimed_by = ?, claimed_at = ?
         where id in (select id from screenshots where claimed_by is null order by id limit ?)`,
		claimID, formatTime(s.opts.Now()), max); err != nil {
		return "", nil, fmt.Errorf("store: could not claim screenshots: %w", err)
	}

	rows, err := tx.QueryContext(ctx, `
        select id, captured_at, path, width, height, byte_count, sha256, blurred
          from screenshots where claimed_by = ? order by id`, claimID)
	if err != nil {
		return "", nil, fmt.Errorf("store: could not read claimed screenshots: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var shots []Screenshot
	for rows.Next() {
		var (
			shot       Screenshot
			capturedAt string
			blurred    int
		)
		if err := rows.Scan(&shot.ID, &capturedAt, &shot.Path, &shot.Width, &shot.Height,
			&shot.ByteCount, &shot.SHA256, &blurred); err != nil {
			return "", nil, fmt.Errorf("store: could not scan a claimed screenshot: %w", err)
		}
		parsed, err := parseTime(capturedAt)
		if err != nil {
			return "", nil, fmt.Errorf("store: screenshot %d has an unparseable captured_at: %w", shot.ID, err)
		}
		shot.CapturedAt = parsed
		shot.Blurred = blurred != 0
		shots = append(shots, shot)
	}
	if err := rows.Err(); err != nil {
		return "", nil, fmt.Errorf("store: could not iterate claimed screenshots: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return "", nil, fmt.Errorf("store: could not commit a screenshot claim: %w", err)
	}

	return claimID, shots, nil
}

// DeleteScreenshot removes a queue row and its file.
//
// The row goes first. Reversed, a process death in between would leave a row pointing at a file
// that no longer exists and the uploader would retry it forever.
func (s *Store) DeleteScreenshot(ctx context.Context, id int64, path string) error {
	if _, err := s.db.ExecContext(ctx, `delete from screenshots where id = ?`, id); err != nil {
		return fmt.Errorf("store: could not delete screenshot %d: %w", id, err)
	}
	if path != "" {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			// The row is already gone so this is not fatal, but a leaked image is a privacy
			// problem rather than merely wasted disk — the caller must be able to log it.
			return fmt.Errorf("store: deleted screenshot %d but could not remove %s: %w", id, path, err)
		}
	}
	return nil
}

// Meta keys used by the agent. Constants so a typo is a compile error.
const (
	MetaNoticeAcknowledgedAt = "notice_acknowledged_at"
	MetaConfigVersion        = "config_version"
	MetaConfigJSON           = "config_json"
	MetaLastUploadAt         = "last_upload_at"
	MetaLastConfigFetchAt    = "last_config_fetch_at"
	MetaDroppedEventCount    = "dropped_event_count"
)

// SetMeta stores a small piece of state that must survive a restart.
func (s *Store) SetMeta(ctx context.Context, key, value string) error {
	_, err := s.db.ExecContext(ctx, `
        insert into meta (key, value, updated_at) values (?, ?, ?)
        on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
		key, value, formatTime(s.opts.Now()))
	if err != nil {
		return fmt.Errorf("store: could not write meta key %q: %w", key, err)
	}
	return nil
}

// GetMeta reads state, reporting whether it was present. A missing key is not an error — the
// first run has none of them.
func (s *Store) GetMeta(ctx context.Context, key string) (string, bool, error) {
	var value string
	err := s.db.QueryRowContext(ctx, `select value from meta where key = ?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("store: could not read meta key %q: %w", key, err)
	}
	return value, true, nil
}

// Vacuum reclaims space after a large delete.
//
// Worth running after the cap has dropped a lot of rows: SQLite does not shrink the file on its
// own, so a buffer that once spiked to its cap would otherwise stay that size on disk forever.
func (s *Store) Vacuum(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, "vacuum"); err != nil {
		return fmt.Errorf("store: vacuum failed: %w", err)
	}
	return nil
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// nullable maps an empty string to SQL NULL.
//
// The server distinguishes "no application" from "an application whose name is the empty
// string", and its idle-attribution CHECK is written against NULL. Storing "" would send "" and
// be rejected.
func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}
