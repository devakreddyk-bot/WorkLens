// Package config owns the agent's on-disk state: where it lives, what it is allowed to collect,
// and the credential it signs with.
//
// Three separate things, deliberately kept in three separate places:
//
//	config.json       Machine-level settings the deployer chooses: the API URL, TLS pins,
//	                  log level, intervals. Readable; contains no secret.
//	credentials.json  The device id and secret from enrolment. Written 0600, never logged,
//	                  never in the same file as anything a support engineer might be asked
//	                  to paste into a ticket.
//	the buffer's meta The organisation's monitoring configuration, cached from the server so
//	                  the agent keeps honouring the right rules while offline.
//
// Splitting the credential out is the point of the arrangement. A single settings file gets
// screenshotted, emailed, and pasted into chat threads when something goes wrong; the secret
// must not be in it.
//
// # Precedence
//
// Environment variables override the file, and the file overrides the defaults. That order lets
// a deployer test against a staging endpoint without editing a file the installer manages, and
// it is the order every operator already expects.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// File and directory names, relative to the agent's data directory.
const (
	ConfigFileName      = "config.json"
	CredentialsFileName = "credentials.json"
	BufferFileName      = "buffer.db"
	LogFileName         = "worklens-agent.log"
	ScreenshotQueueDir  = "queue"
)

// Environment variables the agent reads. Namespaced so they cannot collide with anything else
// on a corporate image.
const (
	EnvDataDir    = "WORKLENS_DATA_DIR"
	EnvAPIBaseURL = "WORKLENS_API_BASE_URL"
	EnvTLSPinning = "WORKLENS_TLS_PINNING"
	EnvTLSPins    = "WORKLENS_TLS_PINS"
	EnvLogLevel   = "WORKLENS_LOG_LEVEL"
)

// Settings is the machine-level configuration, as stored in config.json.
//
// Every field has a working default, so a missing or empty config.json produces a functioning
// agent rather than an error — the installer writes only the API URL in the common case.
type Settings struct {
	// APIBaseURL is the deployment's API root, e.g. https://abc123.execute-api.ap-south-1.amazonaws.com/v1
	APIBaseURL string `json:"api_base_url"`

	// TLSPinningEnabled turns certificate pinning off. The only legitimate reason is a
	// deployment behind a mandatory corporate TLS-inspection proxy, where pinning cannot work
	// and the alternative is an agent that does not function at all. The agent logs a warning on
	// every startup when this is false — a silent downgrade would be worse than no pinning.
	TLSPinningEnabled *bool `json:"tls_pinning_enabled,omitempty"`

	// TLSPins overrides the built-in Amazon root pins. Base64 or hex SHA-256 SPKI digests.
	TLSPins []string `json:"tls_pins,omitempty"`

	// LogLevel is debug, info, warn or error.
	LogLevel string `json:"log_level,omitempty"`

	// UploadInterval is how often the uploader drains the buffer. The sample interval itself
	// comes from the server's monitoring configuration, not from here: what is collected is the
	// organisation's decision, while how often it is shipped is a machine concern.
	UploadIntervalSeconds int `json:"upload_interval_seconds,omitempty"`

	// ConfigPollIntervalSeconds is how often the agent re-fetches the organisation's monitoring
	// configuration, so a policy change reaches the fleet without a restart.
	ConfigPollIntervalSeconds int `json:"config_poll_interval_seconds,omitempty"`

	// HeartbeatIntervalSeconds is how often the agent reports liveness, which is what makes
	// "this laptop has not checked in since Tuesday" visible on the dashboard.
	HeartbeatIntervalSeconds int `json:"heartbeat_interval_seconds,omitempty"`

	// MaxBatchEvents caps one upload. Must not exceed the server's limit or every batch is
	// rejected; the server's default is 500.
	MaxBatchEvents int `json:"max_batch_events,omitempty"`

	// BufferMaxBytes and BufferMaxAgeHours cap the local buffer.
	BufferMaxBytes    int64 `json:"buffer_max_bytes,omitempty"`
	BufferMaxAgeHours int   `json:"buffer_max_age_hours,omitempty"`

	// DashboardURL is where the employee sees their own data. It appears in the first-run notice
	// and in the tray menu, so an employee told they are monitored is also told where to look.
	DashboardURL string `json:"dashboard_url,omitempty"`

	// The notice names the organisation and gives a person to ask. A notice that tells somebody
	// they are being monitored and offers nobody to contact has informed them of very little, so
	// these are settings rather than prose — and Validate warns when they are missing.
	NoticeOrgName      string `json:"notice_org_name,omitempty"`
	NoticeContactName  string `json:"notice_contact_name,omitempty"`
	NoticeContactEmail string `json:"notice_contact_email,omitempty"`
}

// NoticeIsComplete reports whether the notice can name the organisation and a contact.
//
// Not part of Validate: an incomplete notice must not stop the agent from running, because the
// alternative is a deployer removing the notice to get past a startup error. The agent logs a
// warning instead, and `agentctl doctor` reports it as something to fix before rollout.
func (s Settings) NoticeIsComplete() bool {
	return strings.TrimSpace(s.NoticeOrgName) != "" &&
		strings.TrimSpace(s.NoticeContactEmail) != ""
}

// Defaults. The upload interval is 60s to match a 60s sample interval — batching more
// aggressively would delay a timesheet without saving meaningful bandwidth, since a batch of 60
// samples is a few kilobytes either way.
const (
	DefaultUploadIntervalSeconds     = 60
	DefaultConfigPollIntervalSeconds = 900
	DefaultHeartbeatIntervalSeconds  = 300
	DefaultMaxBatchEvents            = 500
	DefaultLogLevel                  = "info"
)

// Credentials is the device identity written by enrolment.
//
// Stored separately from Settings and never logged. The secret is the agent's only copy: the
// server derives it from a root key and does not store it (docs/PLAN.md deviation D4), so losing
// this file means re-enrolling the device, and leaking it means someone can submit activity as
// this device until it is revoked.
type Credentials struct {
	DeviceID   string `json:"device_id"`
	Secret     string `json:"device_secret"`
	OrgID      string `json:"org_id"`
	EmployeeID string `json:"employee_id"`
	EnrolledAt string `json:"enrolled_at"`
	// KeyVersion records which root key version the secret was derived from, so a support
	// engineer can tell a rotation problem from a revocation without guessing.
	KeyVersion int `json:"key_version"`
}

// Valid reports whether the credential is usable.
func (c Credentials) Valid() bool {
	return c.DeviceID != "" && c.Secret != "" && c.OrgID != "" && c.EmployeeID != ""
}

// String deliberately omits the secret.
//
// Implemented so that a credential accidentally passed to a logger, a %v, or an error message
// cannot print the secret. Relying on every call site to remember is exactly the assumption that
// eventually fails.
func (c Credentials) String() string {
	return fmt.Sprintf("Credentials{DeviceID:%s OrgID:%s EmployeeID:%s KeyVersion:%d Secret:[redacted]}",
		c.DeviceID, c.OrgID, c.EmployeeID, c.KeyVersion)
}

// Paths resolves every file the agent touches.
type Paths struct {
	DataDir         string
	ConfigFile      string
	CredentialsFile string
	BufferFile      string
	LogFile         string
	ScreenshotDir   string
}

// DefaultDataDir returns the per-user data directory.
//
// Per-user, not per-machine, and that follows from deviation D5: the agent runs as a logon task
// in the interactive user's session, not as a SYSTEM service. Its buffer contains that user's
// window titles, so it belongs under their profile with their ACL, where another user of the
// same machine cannot read it.
//
// On Windows this is %LOCALAPPDATA%\WorkLens — LocalAppData rather than AppData\Roaming because
// a roaming profile would sync a SQLite database between machines, which corrupts it.
func DefaultDataDir() (string, error) {
	if override := strings.TrimSpace(os.Getenv(EnvDataDir)); override != "" {
		return override, nil
	}

	if runtime.GOOS == "windows" {
		if local := os.Getenv("LOCALAPPDATA"); local != "" {
			return filepath.Join(local, "WorkLens"), nil
		}
		// LOCALAPPDATA is always set in an interactive session. If it is missing, the agent is
		// running somewhere unexpected — session 0, a service, a scheduled task with the wrong
		// account — and guessing a path would hide that.
		return "", errors.New(
			"config: LOCALAPPDATA is not set. The agent runs as a logon task in the user's own " +
				"session (see docs/PLAN.md D5); an empty LOCALAPPDATA usually means it was " +
				"installed as a service instead, where it cannot observe the desktop at all")
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("config: could not determine the home directory: %w", err)
	}
	return filepath.Join(home, ".worklens"), nil
}

// ResolvePaths builds the path set for a data directory, creating it if needed.
func ResolvePaths(dataDir string) (Paths, error) {
	if dataDir == "" {
		resolved, err := DefaultDataDir()
		if err != nil {
			return Paths{}, err
		}
		dataDir = resolved
	}

	paths := Paths{
		DataDir:         dataDir,
		ConfigFile:      filepath.Join(dataDir, ConfigFileName),
		CredentialsFile: filepath.Join(dataDir, CredentialsFileName),
		BufferFile:      filepath.Join(dataDir, BufferFileName),
		LogFile:         filepath.Join(dataDir, LogFileName),
		ScreenshotDir:   filepath.Join(dataDir, ScreenshotQueueDir),
	}

	// 0700 on both directories. The buffer and the screenshot queue hold personal data; another
	// user of the same machine has no business reading either.
	for _, dir := range []string{paths.DataDir, paths.ScreenshotDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return Paths{}, fmt.Errorf("config: could not create %s: %w", dir, err)
		}
	}

	return paths, nil
}

// LoadSettings reads config.json, applies environment overrides, fills defaults, and validates.
//
// A missing file is not an error: the defaults plus an API URL from the environment are enough to
// run, which is what makes a scripted install straightforward.
func LoadSettings(path string) (Settings, error) {
	var settings Settings

	raw, err := os.ReadFile(path)
	switch {
	case err == nil:
		// DisallowUnknownFields on purpose: a typo in a setting name would otherwise be silently
		// ignored, and the operator would conclude the setting does not work.
		decoder := json.NewDecoder(strings.NewReader(string(raw)))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&settings); err != nil {
			return Settings{}, fmt.Errorf("config: %s is not valid: %w", path, err)
		}
	case errors.Is(err, os.ErrNotExist):
		// Defaults only.
	default:
		return Settings{}, fmt.Errorf("config: could not read %s: %w", path, err)
	}

	applyEnvOverrides(&settings)
	settings.applyDefaults()

	if err := settings.Validate(); err != nil {
		return Settings{}, err
	}
	return settings, nil
}

func applyEnvOverrides(settings *Settings) {
	if v := strings.TrimSpace(os.Getenv(EnvAPIBaseURL)); v != "" {
		settings.APIBaseURL = v
	}
	if v := strings.TrimSpace(os.Getenv(EnvLogLevel)); v != "" {
		settings.LogLevel = v
	}

	// Accept the obvious spellings. An operator who writes "0" or "false" or "no" means the same
	// thing, and refusing one of them would look like the flag is broken.
	if v := strings.ToLower(strings.TrimSpace(os.Getenv(EnvTLSPinning))); v != "" {
		switch v {
		case "off", "0", "false", "no", "disabled":
			disabled := false
			settings.TLSPinningEnabled = &disabled
		case "on", "1", "true", "yes", "enabled":
			enabled := true
			settings.TLSPinningEnabled = &enabled
		}
	}

	if v := strings.TrimSpace(os.Getenv(EnvTLSPins)); v != "" {
		var pins []string
		for _, pin := range strings.Split(v, ",") {
			if trimmed := strings.TrimSpace(pin); trimmed != "" {
				pins = append(pins, trimmed)
			}
		}
		if len(pins) > 0 {
			settings.TLSPins = pins
		}
	}
}

func (s *Settings) applyDefaults() {
	if s.LogLevel == "" {
		s.LogLevel = DefaultLogLevel
	}
	if s.UploadIntervalSeconds <= 0 {
		s.UploadIntervalSeconds = DefaultUploadIntervalSeconds
	}
	if s.ConfigPollIntervalSeconds <= 0 {
		s.ConfigPollIntervalSeconds = DefaultConfigPollIntervalSeconds
	}
	if s.HeartbeatIntervalSeconds <= 0 {
		s.HeartbeatIntervalSeconds = DefaultHeartbeatIntervalSeconds
	}
	if s.MaxBatchEvents <= 0 {
		s.MaxBatchEvents = DefaultMaxBatchEvents
	}
}

// PinningEnabled reports whether certificate pinning is on. Absent means on: pinning must be the
// default, and turning it off must be an explicit act.
func (s Settings) PinningEnabled() bool {
	return s.TLSPinningEnabled == nil || *s.TLSPinningEnabled
}

// Validate rejects settings that would produce a broken or unsafe agent.
func (s Settings) Validate() error {
	if s.APIBaseURL == "" {
		return fmt.Errorf(
			"config: no API base URL. Set it in config.json as api_base_url, or export %s. "+
				"`worklens-agentctl enroll` writes it for you", EnvAPIBaseURL)
	}

	parsed, err := url.Parse(s.APIBaseURL)
	if err != nil {
		return fmt.Errorf("config: api_base_url %q is not a URL: %w", s.APIBaseURL, err)
	}

	// Plain HTTP is refused outright rather than warned about. The agent transmits window titles;
	// there is no deployment where sending them in clear text is acceptable, and a warning would
	// be ignored. localhost is exempt so the endpoints can be exercised against a local stub.
	if parsed.Scheme != "https" {
		isLocal := parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1"
		if !(parsed.Scheme == "http" && isLocal) {
			return fmt.Errorf(
				"config: api_base_url must be https (got %q). The agent transmits window titles, "+
					"which are personal data; http is permitted only against localhost for testing",
				s.APIBaseURL)
		}
	}

	if parsed.Host == "" {
		return fmt.Errorf("config: api_base_url %q has no host", s.APIBaseURL)
	}

	switch s.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		return fmt.Errorf("config: log_level %q must be debug, info, warn or error", s.LogLevel)
	}

	// The server's own cap is 500. A larger batch is rejected in its entirety, so every upload
	// would fail — and the agent would look offline while being perfectly connected.
	if s.MaxBatchEvents > 500 {
		return fmt.Errorf(
			"config: max_batch_events is %d; the server accepts at most 500 per batch and "+
				"rejects an oversized batch whole, so every upload would fail", s.MaxBatchEvents)
	}

	return nil
}

// Host returns the API hostname, for the TLS ServerName and the pin error message.
func (s Settings) Host() string {
	parsed, err := url.Parse(s.APIBaseURL)
	if err != nil {
		return ""
	}
	return parsed.Hostname()
}

// UploadInterval and friends return the settings as durations.
func (s Settings) UploadInterval() time.Duration {
	return time.Duration(s.UploadIntervalSeconds) * time.Second
}

// ConfigPollInterval is how often the monitoring configuration is refreshed.
func (s Settings) ConfigPollInterval() time.Duration {
	return time.Duration(s.ConfigPollIntervalSeconds) * time.Second
}

// HeartbeatInterval is how often liveness is reported.
func (s Settings) HeartbeatInterval() time.Duration {
	return time.Duration(s.HeartbeatIntervalSeconds) * time.Second
}

// SaveSettings writes config.json.
func SaveSettings(path string, settings Settings) error {
	encoded, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return fmt.Errorf("config: could not encode settings: %w", err)
	}
	return writeFileAtomic(path, append(encoded, '\n'), 0o600)
}

// LoadCredentials reads credentials.json.
//
// Returns ErrNotEnrolled when the file is absent, which is a normal state rather than a failure:
// the agent starts, shows "not enrolled" in the tray, and captures nothing.
func LoadCredentials(path string) (Credentials, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Credentials{}, ErrNotEnrolled
	}
	if err != nil {
		return Credentials{}, fmt.Errorf("config: could not read credentials: %w", err)
	}

	var creds Credentials
	if err := json.Unmarshal(raw, &creds); err != nil {
		// The error deliberately does not include the file contents, which is the one place a
		// malformed-file message could leak the secret into a log.
		return Credentials{}, fmt.Errorf("config: %s is not valid JSON", path)
	}

	if !creds.Valid() {
		return Credentials{}, fmt.Errorf(
			"config: %s is missing a device id, secret, org or employee. Re-enrol with "+
				"`worklens-agentctl enroll --token wlen_...`", path)
	}

	return creds, nil
}

// ErrNotEnrolled means no credential is present. Not a failure: the agent runs, reports itself
// unenrolled in the tray, and captures nothing until it is enrolled.
var ErrNotEnrolled = errors.New("config: this device is not enrolled")

// SaveCredentials writes credentials.json with restrictive permissions.
func SaveCredentials(path string, creds Credentials) error {
	if !creds.Valid() {
		return errors.New("config: refusing to write an incomplete credential")
	}

	encoded, err := json.MarshalIndent(creds, "", "  ")
	if err != nil {
		return fmt.Errorf("config: could not encode credentials: %w", err)
	}

	// 0600. On Windows the mode is advisory — the installer's ACL is what actually restricts the
	// file — but on a developer's machine it is real, and there is no reason to be lax.
	return writeFileAtomic(path, append(encoded, '\n'), 0o600)
}

// DeleteCredentials removes the credential, for `agentctl unenroll`.
func DeleteCredentials(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("config: could not delete credentials: %w", err)
	}
	return nil
}

// writeFileAtomic writes via a temporary file and a rename.
//
// A direct write that is interrupted — a crash, a full disk, a laptop losing power — leaves a
// truncated file. For credentials.json that means an agent that cannot authenticate and cannot
// explain why; the rename makes the update all-or-nothing.
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	temp, err := os.CreateTemp(dir, filepath.Base(path)+".tmp-*")
	if err != nil {
		return fmt.Errorf("config: could not create a temporary file in %s: %w", dir, err)
	}
	tempName := temp.Name()

	// Best-effort cleanup on every failure path below.
	defer func() { _ = os.Remove(tempName) }()

	if err := temp.Chmod(perm); err != nil {
		_ = temp.Close()
		return fmt.Errorf("config: could not set permissions on %s: %w", tempName, err)
	}
	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()
		return fmt.Errorf("config: could not write %s: %w", tempName, err)
	}
	// Sync before rename: without it the rename can be durable while the contents are not, which
	// is the truncated-file case this function exists to avoid.
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return fmt.Errorf("config: could not flush %s: %w", tempName, err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("config: could not close %s: %w", tempName, err)
	}

	if err := os.Rename(tempName, path); err != nil {
		return fmt.Errorf("config: could not replace %s: %w", path, err)
	}
	return nil
}

// MonitoringConfig is the organisation's collection policy, as served by GET /v1/device/config.
//
// Field names match the API payload. Cached in the buffer's meta table so the agent keeps
// honouring the correct rules while offline — an agent that reverted to defaults after a restart
// would start collecting things the organisation had turned off.
type MonitoringConfig struct {
	ConfigVersion int `json:"config_version"`

	SampleIntervalSeconds int `json:"sample_interval_seconds"`
	IdleThresholdSeconds  int `json:"idle_threshold_seconds"`

	CaptureWindowTitles bool `json:"capture_window_titles"`
	CaptureURLs         bool `json:"capture_urls"`

	ScreenshotEnabled         bool `json:"screenshot_enabled"`
	ScreenshotIntervalSeconds int  `json:"screenshot_interval_seconds"`
	ScreenshotBlur            bool `json:"screenshot_blur"`

	WorkHoursOnly  bool   `json:"work_hours_only"`
	WorkHoursStart string `json:"work_hours_start"`
	WorkHoursEnd   string `json:"work_hours_end"`
	// WorkDays uses ISO-8601 numbering: 1 = Monday … 7 = Sunday. Go's time.Weekday is
	// Sunday-based; internal/privacy converts, in exactly one place.
	WorkDays []int `json:"work_days"`

	ExcludedApps        []string `json:"excluded_apps"`
	ExcludedURLPatterns []string `json:"excluded_url_patterns"`

	RetentionDaysEvents      int `json:"retention_days_events"`
	RetentionDaysScreenshots int `json:"retention_days_screenshots"`

	// Timezone is the employee's IANA zone. Work hours are local to the person, not the server.
	Timezone string `json:"timezone"`
}

// LeastInvasiveConfig is what the agent uses before it has ever reached the server.
//
// It matters that this is the least-invasive setting rather than a neutral one: an agent that has
// not yet fetched a policy must not collect more than the policy would allow, and the failure
// mode of guessing generously is collecting data the organisation had switched off.
func LeastInvasiveConfig() MonitoringConfig {
	return MonitoringConfig{
		ConfigVersion:             0,
		SampleIntervalSeconds:     60,
		IdleThresholdSeconds:      300,
		CaptureWindowTitles:       false,
		CaptureURLs:               false,
		ScreenshotEnabled:         false,
		ScreenshotIntervalSeconds: 900,
		ScreenshotBlur:            true,
		WorkHoursOnly:             true,
		WorkHoursStart:            "09:00",
		WorkHoursEnd:              "17:30",
		WorkDays:                  []int{1, 2, 3, 4, 5},
		RetentionDaysEvents:       90,
		RetentionDaysScreenshots:  30,
		Timezone:                  "UTC",
	}
}

// Validate checks a configuration received from the server.
//
// The server validates on write, so a bad value here means a bug or a tampered response. Either
// way the agent must not act on it: falling back to the least-invasive configuration collects
// less than intended, which is the right direction to fail.
func (m MonitoringConfig) Validate() error {
	if m.SampleIntervalSeconds < 15 || m.SampleIntervalSeconds > 900 {
		return fmt.Errorf("config: sample_interval_seconds %d is outside 15-900", m.SampleIntervalSeconds)
	}
	if m.IdleThresholdSeconds < 60 || m.IdleThresholdSeconds > 3600 {
		return fmt.Errorf("config: idle_threshold_seconds %d is outside 60-3600", m.IdleThresholdSeconds)
	}
	if m.ScreenshotEnabled && (m.ScreenshotIntervalSeconds < 60 || m.ScreenshotIntervalSeconds > 7200) {
		return fmt.Errorf("config: screenshot_interval_seconds %d is outside 60-7200", m.ScreenshotIntervalSeconds)
	}
	if len(m.WorkDays) == 0 || len(m.WorkDays) > 7 {
		return fmt.Errorf("config: work_days has %d entries, expected 1-7", len(m.WorkDays))
	}
	for _, day := range m.WorkDays {
		if day < 1 || day > 7 {
			return fmt.Errorf("config: work_days contains %d; ISO weekdays are 1 (Monday) to 7 (Sunday)", day)
		}
	}
	if m.Timezone == "" {
		return errors.New("config: the monitoring configuration has no timezone")
	}
	if _, err := time.LoadLocation(m.Timezone); err != nil {
		return fmt.Errorf("config: timezone %q is not a known IANA zone: %w", m.Timezone, err)
	}
	return nil
}

// Location resolves the employee's timezone, falling back to UTC.
//
// UTC rather than the machine's local zone: a laptop's timezone is user-changeable and the
// work-hours window is employer policy, so it must not move because somebody changed a system
// setting on a trip.
func (m MonitoringConfig) Location() *time.Location {
	if m.Timezone == "" {
		return time.UTC
	}
	loc, err := time.LoadLocation(m.Timezone)
	if err != nil {
		return time.UTC
	}
	return loc
}

// SampleInterval is how often the sampler ticks.
func (m MonitoringConfig) SampleInterval() time.Duration {
	return time.Duration(m.SampleIntervalSeconds) * time.Second
}

// IdleThreshold is how long without input counts as idle.
func (m MonitoringConfig) IdleThreshold() time.Duration {
	return time.Duration(m.IdleThresholdSeconds) * time.Second
}

// ScreenshotInterval is how often a screenshot is taken when they are enabled.
func (m MonitoringConfig) ScreenshotInterval() time.Duration {
	return time.Duration(m.ScreenshotIntervalSeconds) * time.Second
}

// Marshal serialises the configuration for the buffer's meta table.
func (m MonitoringConfig) Marshal() (string, error) {
	encoded, err := json.Marshal(m)
	if err != nil {
		return "", fmt.Errorf("config: could not encode the monitoring configuration: %w", err)
	}
	return string(encoded), nil
}

// UnmarshalMonitoringConfig parses a cached configuration.
func UnmarshalMonitoringConfig(encoded string) (MonitoringConfig, error) {
	var m MonitoringConfig
	if err := json.Unmarshal([]byte(encoded), &m); err != nil {
		return MonitoringConfig{}, fmt.Errorf("config: cached monitoring configuration is not valid JSON: %w", err)
	}
	return m, nil
}

// ConfigResponse is the body of GET /v1/device/config.
//
// The settings are nested under `config`, with the version and the server clock alongside them.
// This type exists because that nesting was missed once, with consequences worth recording: the
// daemon passed the whole response body to UnmarshalMonitoringConfig, whose fields are all at the
// top level. Only config_version matched, every setting decoded to its zero value, and Validate()
// then rejected the result on "sample_interval_seconds 0 is outside 15-900". The agent logged that
// the configuration was invalid, kept the cached one, and did so forever.
//
// It failed safe — the agent never collected more than it was already permitted to — but it failed
// closed on the one call that the handler's own comment calls "the single most important one on the
// device API: it is how an owner turning screenshots off, or adding a banking domain to the
// exclusion list, actually reaches a laptop". An owner could change a setting in the dashboard, see
// it saved, and have it never reach the fleet.
//
// The enrolment path in internal/uploader modelled the same envelope correctly, so the agent's two
// config paths disagreed with each other. contracts/device-config-response.json now pins the shape
// from both sides, the way contracts/signature-vectors.json pins the signing scheme.
type ConfigResponse struct {
	Config        MonitoringConfig `json:"config"`
	ConfigVersion int              `json:"config_version"`
	// ServerTime lets the agent notice clock drift that has not yet grown large enough to fail the
	// signature window. `agentctl doctor` reports on it.
	ServerTime string `json:"server_time"`
}

// UnmarshalConfigResponse parses a GET /v1/device/config body into a usable configuration.
//
// The version comes from the envelope rather than from the nested object, because that is where the
// server puts it: `presentAgentConfig` projects the settings and deliberately does not include
// config_version among them. Returning the merged value means a caller cannot forget to copy it and
// then compare a zero against the version it holds — which would make every poll look like a change.
func UnmarshalConfigResponse(encoded []byte) (MonitoringConfig, error) {
	var response ConfigResponse
	if err := json.Unmarshal(encoded, &response); err != nil {
		return MonitoringConfig{}, fmt.Errorf("config: the monitoring configuration response is not valid JSON: %w", err)
	}
	merged := response.Config
	merged.ConfigVersion = response.ConfigVersion
	return merged, nil
}

// FormatVersion renders a config version for the meta table.
func FormatVersion(version int) string { return strconv.Itoa(version) }

// ParseVersion reads a config version from the meta table.
func ParseVersion(value string) (int, error) {
	version, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil {
		return 0, fmt.Errorf("config: %q is not a config version: %w", value, err)
	}
	return version, nil
}
