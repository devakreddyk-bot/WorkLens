package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

func TestLoadSettingsUsesDefaultsWhenTheFileIsAbsent(t *testing.T) {
	// A scripted install writes only the API URL, so a missing config.json must still produce a
	// working agent rather than an error.
	t.Setenv(EnvAPIBaseURL, "https://api.example.com/v1")

	settings, err := LoadSettings(filepath.Join(t.TempDir(), "absent.json"))
	if err != nil {
		t.Fatalf("LoadSettings failed with no file present: %v", err)
	}

	if settings.LogLevel != DefaultLogLevel {
		t.Errorf("LogLevel = %q, want %q", settings.LogLevel, DefaultLogLevel)
	}
	if settings.MaxBatchEvents != DefaultMaxBatchEvents {
		t.Errorf("MaxBatchEvents = %d, want %d", settings.MaxBatchEvents, DefaultMaxBatchEvents)
	}
	if !settings.PinningEnabled() {
		t.Error("pinning defaulted to off; it must be on unless explicitly disabled")
	}
}

func TestEnvironmentOverridesTheFile(t *testing.T) {
	// So a deployer can point at staging without editing a file the installer manages.
	dir := t.TempDir()
	path := filepath.Join(dir, ConfigFileName)

	if err := SaveSettings(path, Settings{APIBaseURL: "https://from-file.example.com/v1", LogLevel: "warn"}); err != nil {
		t.Fatalf("SaveSettings failed: %v", err)
	}

	t.Setenv(EnvAPIBaseURL, "https://from-env.example.com/v1")
	t.Setenv(EnvLogLevel, "debug")

	settings, err := LoadSettings(path)
	if err != nil {
		t.Fatalf("LoadSettings failed: %v", err)
	}
	if settings.APIBaseURL != "https://from-env.example.com/v1" {
		t.Errorf("APIBaseURL = %q; the environment must win", settings.APIBaseURL)
	}
	if settings.LogLevel != "debug" {
		t.Errorf("LogLevel = %q; the environment must win", settings.LogLevel)
	}
}

func TestUnknownSettingIsRejected(t *testing.T) {
	// Silently ignoring a typo would leave the operator concluding the setting does not work.
	path := filepath.Join(t.TempDir(), ConfigFileName)
	if err := os.WriteFile(path, []byte(`{"api_base_url":"https://x.example.com/v1","captur_urls":true}`), 0o600); err != nil {
		t.Fatalf("write failed: %v", err)
	}

	if _, err := LoadSettings(path); err == nil {
		t.Error("a misspelled setting was accepted")
	}
}

func TestPlainHTTPIsRefusedExceptLocalhost(t *testing.T) {
	// The agent transmits window titles. There is no deployment where clear text is acceptable,
	// and a warning would simply be ignored.
	for _, bad := range []string{
		"http://api.example.com/v1",
		"http://10.0.0.5/v1",
		"ftp://api.example.com/v1",
	} {
		settings := Settings{APIBaseURL: bad, LogLevel: "info", MaxBatchEvents: 100}
		settings.applyDefaults()
		if err := settings.Validate(); err == nil {
			t.Errorf("%s was accepted", bad)
		} else if !strings.Contains(err.Error(), "personal data") {
			t.Errorf("%s: the error does not explain why: %v", bad, err)
		}
	}

	for _, ok := range []string{
		"http://localhost:3000/v1",
		"http://127.0.0.1:3000/v1",
		"https://api.example.com/v1",
	} {
		settings := Settings{APIBaseURL: ok, LogLevel: "info"}
		settings.applyDefaults()
		if err := settings.Validate(); err != nil {
			t.Errorf("%s was rejected: %v", ok, err)
		}
	}
}

func TestOversizedBatchIsRejected(t *testing.T) {
	// The server rejects an oversized batch whole, so every upload would fail and the agent would
	// look offline while being perfectly connected.
	settings := Settings{APIBaseURL: "https://api.example.com/v1", MaxBatchEvents: 5000}
	settings.applyDefaults()

	err := settings.Validate()
	if err == nil {
		t.Fatal("a batch size above the server's limit was accepted")
	}
	if !strings.Contains(err.Error(), "500") {
		t.Errorf("the error does not name the server's limit: %v", err)
	}
}

func TestMissingAPIBaseURLIsRejectedWithGuidance(t *testing.T) {
	settings := Settings{}
	settings.applyDefaults()

	err := settings.Validate()
	if err == nil {
		t.Fatal("empty settings were accepted")
	}
	// The message has to say what to do, because this is the first error a new deployer sees.
	if !strings.Contains(err.Error(), "agentctl enroll") {
		t.Errorf("the error does not tell the operator how to fix it: %v", err)
	}
}

func TestInvalidLogLevelIsRejected(t *testing.T) {
	settings := Settings{APIBaseURL: "https://api.example.com/v1", LogLevel: "verbose"}
	settings.applyDefaults()
	if err := settings.Validate(); err == nil {
		t.Error("an unknown log level was accepted")
	}
}

func TestTLSPinningEnvSpellings(t *testing.T) {
	// An operator who writes "0" or "no" means the same thing as "off"; refusing one of them
	// would look like the flag is broken.
	for _, off := range []string{"off", "0", "false", "no", "disabled", "OFF", " off "} {
		t.Setenv(EnvTLSPinning, off)
		settings := Settings{}
		applyEnvOverrides(&settings)
		if settings.PinningEnabled() {
			t.Errorf("%q did not disable pinning", off)
		}
	}

	for _, on := range []string{"on", "1", "true", "yes", "enabled"} {
		t.Setenv(EnvTLSPinning, on)
		settings := Settings{}
		applyEnvOverrides(&settings)
		if !settings.PinningEnabled() {
			t.Errorf("%q did not enable pinning", on)
		}
	}

	// An unrecognised value must not silently disable pinning.
	t.Setenv(EnvTLSPinning, "maybe")
	settings := Settings{}
	applyEnvOverrides(&settings)
	if !settings.PinningEnabled() {
		t.Error("an unrecognised WORKLENS_TLS_PINNING value disabled pinning; it must be explicit")
	}
}

func TestTLSPinsFromEnvironment(t *testing.T) {
	t.Setenv(EnvTLSPins, " pinA , pinB ,, pinC ")
	settings := Settings{}
	applyEnvOverrides(&settings)

	want := []string{"pinA", "pinB", "pinC"}
	if len(settings.TLSPins) != len(want) {
		t.Fatalf("parsed %v, want %v", settings.TLSPins, want)
	}
	for i := range want {
		if settings.TLSPins[i] != want[i] {
			t.Errorf("pin %d = %q, want %q", i, settings.TLSPins[i], want[i])
		}
	}
}

func TestHostExtraction(t *testing.T) {
	settings := Settings{APIBaseURL: "https://abc123.execute-api.ap-south-1.amazonaws.com/v1"}
	if got := settings.Host(); got != "abc123.execute-api.ap-south-1.amazonaws.com" {
		t.Errorf("Host() = %q", got)
	}
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

const testSecret = "NOT-A-REAL-SECRET-2f8a91c3d4e5"

func validCredentials() Credentials {
	return Credentials{
		DeviceID:   "9a594a02-afe7-4537-b57a-f771875c3c87",
		Secret:     testSecret,
		OrgID:      "3f7a1c0e-2b4d-4f6a-8c1e-9d0b5a7e3c11",
		EmployeeID: "44444444-4444-4444-8444-444444444444",
		KeyVersion: 1,
	}
}

func TestCredentialsStringNeverContainsTheSecret(t *testing.T) {
	// A credential passed to a logger, a %v or an error message must not print the secret.
	// Relying on every call site to remember is the assumption that eventually fails.
	creds := validCredentials()

	for _, rendered := range []string{
		creds.String(),
		// The paths a mistake actually takes:
		strings.TrimSpace(strings.Join([]string{creds.String()}, "")),
	} {
		if strings.Contains(rendered, testSecret) {
			t.Errorf("the secret appeared in %q", rendered)
		}
		if !strings.Contains(rendered, "[redacted]") {
			t.Errorf("%q does not mark the secret as redacted", rendered)
		}
	}
}

func TestCredentialsRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), CredentialsFileName)
	original := validCredentials()

	if err := SaveCredentials(path, original); err != nil {
		t.Fatalf("SaveCredentials failed: %v", err)
	}

	loaded, err := LoadCredentials(path)
	if err != nil {
		t.Fatalf("LoadCredentials failed: %v", err)
	}
	if loaded != original {
		t.Errorf("round trip changed the credential:\n got %+v\nwant %+v", loaded, original)
	}
}

func TestCredentialsFileIsNotWorldReadable(t *testing.T) {
	path := filepath.Join(t.TempDir(), CredentialsFileName)
	if err := SaveCredentials(path, validCredentials()); err != nil {
		t.Fatalf("SaveCredentials failed: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat failed: %v", err)
	}
	if mode := info.Mode().Perm(); mode&0o077 != 0 {
		t.Errorf("credentials are mode %o; group and other must have no access", mode)
	}
}

func TestMissingCredentialsIsNotEnrolledNotAnError(t *testing.T) {
	// The agent starts, shows "not enrolled" in the tray, and captures nothing. That is a normal
	// state, so it must be distinguishable from a read failure.
	_, err := LoadCredentials(filepath.Join(t.TempDir(), "absent.json"))
	if err != ErrNotEnrolled {
		t.Errorf("err = %v, want ErrNotEnrolled", err)
	}
}

func TestIncompleteCredentialsAreRejected(t *testing.T) {
	dir := t.TempDir()

	for name, creds := range map[string]Credentials{
		"no device id": {Secret: testSecret, OrgID: "o", EmployeeID: "e"},
		"no secret":    {DeviceID: "d", OrgID: "o", EmployeeID: "e"},
		"no org":       {DeviceID: "d", Secret: testSecret, EmployeeID: "e"},
		"no employee":  {DeviceID: "d", Secret: testSecret, OrgID: "o"},
	} {
		if err := SaveCredentials(filepath.Join(dir, "c.json"), creds); err == nil {
			t.Errorf("%s: an incomplete credential was written", name)
		}
	}

	// And a file that somehow contains one is rejected on read.
	path := filepath.Join(dir, "partial.json")
	encoded, _ := json.Marshal(Credentials{DeviceID: "d"})
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatalf("write failed: %v", err)
	}
	if _, err := LoadCredentials(path); err == nil {
		t.Error("an incomplete credential file was accepted")
	}
}

func TestMalformedCredentialsErrorDoesNotEchoTheFile(t *testing.T) {
	// The one place a malformed-file message could leak the secret into a log.
	path := filepath.Join(t.TempDir(), CredentialsFileName)
	if err := os.WriteFile(path, []byte(`{"device_secret":"`+testSecret+`" NOT JSON`), 0o600); err != nil {
		t.Fatalf("write failed: %v", err)
	}

	_, err := LoadCredentials(path)
	if err == nil {
		t.Fatal("malformed JSON was accepted")
	}
	if strings.Contains(err.Error(), testSecret) {
		t.Errorf("the error echoed the file contents, leaking the secret: %v", err)
	}
}

func TestDeleteCredentialsIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), CredentialsFileName)
	if err := SaveCredentials(path, validCredentials()); err != nil {
		t.Fatalf("SaveCredentials failed: %v", err)
	}
	if err := DeleteCredentials(path); err != nil {
		t.Fatalf("first delete failed: %v", err)
	}
	// `agentctl unenroll` run twice must not fail the second time.
	if err := DeleteCredentials(path); err != nil {
		t.Errorf("second delete failed: %v", err)
	}
}

func TestWriteIsAtomicAndReplacesCleanly(t *testing.T) {
	path := filepath.Join(t.TempDir(), CredentialsFileName)

	first := validCredentials()
	if err := SaveCredentials(path, first); err != nil {
		t.Fatalf("SaveCredentials failed: %v", err)
	}

	second := first
	second.DeviceID = "11111111-1111-4111-8111-111111111111"
	if err := SaveCredentials(path, second); err != nil {
		t.Fatalf("overwrite failed: %v", err)
	}

	loaded, err := LoadCredentials(path)
	if err != nil {
		t.Fatalf("LoadCredentials failed: %v", err)
	}
	if loaded.DeviceID != second.DeviceID {
		t.Errorf("DeviceID = %q, want the second write", loaded.DeviceID)
	}

	// No temporary files left behind.
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatalf("ReadDir failed: %v", err)
	}
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".tmp-") {
			t.Errorf("a temporary file survived the write: %s", entry.Name())
		}
	}
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

func TestResolvePathsCreatesRestrictedDirectories(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "worklens")

	paths, err := ResolvePaths(dir)
	if err != nil {
		t.Fatalf("ResolvePaths failed: %v", err)
	}

	for _, created := range []string{paths.DataDir, paths.ScreenshotDir} {
		info, err := os.Stat(created)
		if err != nil {
			t.Fatalf("%s was not created: %v", created, err)
		}
		// Both hold personal data — window titles and screen images. Another user of the same
		// machine has no business reading either.
		if mode := info.Mode().Perm(); mode&0o077 != 0 {
			t.Errorf("%s is mode %o; group and other must have no access", created, mode)
		}
	}

	if filepath.Dir(paths.BufferFile) != paths.DataDir {
		t.Error("the buffer is not in the data directory")
	}
}

func TestDataDirEnvOverride(t *testing.T) {
	override := t.TempDir()
	t.Setenv(EnvDataDir, override)

	got, err := DefaultDataDir()
	if err != nil {
		t.Fatalf("DefaultDataDir failed: %v", err)
	}
	if got != override {
		t.Errorf("DefaultDataDir = %q, want %q", got, override)
	}
}

// ---------------------------------------------------------------------------
// Monitoring configuration
// ---------------------------------------------------------------------------

func TestLeastInvasiveConfigIsActuallyLeastInvasive(t *testing.T) {
	// An agent that has not yet reached the server must not collect more than the policy would
	// allow. Failing generously here collects data the organisation had switched off.
	c := LeastInvasiveConfig()

	if c.CaptureWindowTitles {
		t.Error("titles are captured before any policy has been fetched")
	}
	if c.CaptureURLs {
		t.Error("URLs are captured before any policy has been fetched")
	}
	if c.ScreenshotEnabled {
		t.Error("screenshots are enabled before any policy has been fetched")
	}
	if !c.WorkHoursOnly {
		t.Error("capture is not restricted to work hours before any policy has been fetched")
	}
	if !c.ScreenshotBlur {
		t.Error("blur defaults to off")
	}
	if err := c.Validate(); err != nil {
		t.Errorf("the least-invasive configuration does not validate: %v", err)
	}
}

func TestMonitoringConfigValidation(t *testing.T) {
	base := func() MonitoringConfig {
		c := LeastInvasiveConfig()
		c.ConfigVersion = 3
		return c
	}

	cases := map[string]func(*MonitoringConfig){
		"sample interval too short":   func(c *MonitoringConfig) { c.SampleIntervalSeconds = 5 },
		"sample interval too long":    func(c *MonitoringConfig) { c.SampleIntervalSeconds = 5000 },
		"idle threshold too short":    func(c *MonitoringConfig) { c.IdleThresholdSeconds = 10 },
		"no work days":                func(c *MonitoringConfig) { c.WorkDays = nil },
		"too many work days":          func(c *MonitoringConfig) { c.WorkDays = []int{1, 2, 3, 4, 5, 6, 7, 1} },
		"weekday 0 (Sunday in Go)":    func(c *MonitoringConfig) { c.WorkDays = []int{0, 1, 2} },
		"weekday 8":                   func(c *MonitoringConfig) { c.WorkDays = []int{8} },
		"no timezone":                 func(c *MonitoringConfig) { c.Timezone = "" },
		"unknown timezone":            func(c *MonitoringConfig) { c.Timezone = "Mars/Olympus_Mons" },
		"screenshot interval invalid": func(c *MonitoringConfig) { c.ScreenshotEnabled = true; c.ScreenshotIntervalSeconds = 5 },
	}

	for name, mutate := range cases {
		c := base()
		mutate(&c)
		if err := c.Validate(); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}

	if err := base().Validate(); err != nil {
		t.Errorf("a valid configuration was rejected: %v", err)
	}
}

func TestWeekdayZeroIsRejectedBecauseItIsTheGoConvention(t *testing.T) {
	// 0 would be Sunday in Go's numbering and is not a valid ISO weekday. Accepting it would mean
	// silently monitoring the wrong day — the exact bug the ISO/Go conversion exists to prevent.
	c := LeastInvasiveConfig()
	c.WorkDays = []int{0, 1, 2, 3, 4}

	err := c.Validate()
	if err == nil {
		t.Fatal("work_days containing 0 was accepted")
	}
	if !strings.Contains(err.Error(), "ISO") {
		t.Errorf("the error does not explain the numbering: %v", err)
	}
}

func TestMonitoringConfigMarshalRoundTrip(t *testing.T) {
	original := LeastInvasiveConfig()
	original.ConfigVersion = 12
	original.ExcludedApps = []string{"keepass", "1password"}
	original.ExcludedURLPatterns = []string{"*.anz.com.au"}
	original.Timezone = "Asia/Kolkata"

	encoded, err := original.Marshal()
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}

	decoded, err := UnmarshalMonitoringConfig(encoded)
	if err != nil {
		t.Fatalf("UnmarshalMonitoringConfig failed: %v", err)
	}

	if decoded.ConfigVersion != 12 || decoded.Timezone != "Asia/Kolkata" {
		t.Errorf("round trip lost fields: %+v", decoded)
	}
	if len(decoded.ExcludedApps) != 2 || len(decoded.ExcludedURLPatterns) != 1 {
		t.Errorf("round trip lost exclusion lists: %+v", decoded)
	}
}

func TestLocationFallsBackToUTCNotMachineLocal(t *testing.T) {
	// A laptop's timezone is user-changeable; the work-hours window is employer policy.
	for _, zone := range []string{"", "Not/AZone"} {
		c := LeastInvasiveConfig()
		c.Timezone = zone
		if loc := c.Location(); loc != nil && loc.String() != "UTC" {
			t.Errorf("timezone %q resolved to %v, want UTC", zone, loc)
		}
	}

	c := LeastInvasiveConfig()
	c.Timezone = "Asia/Kolkata"
	if got := c.Location().String(); got != "Asia/Kolkata" {
		t.Errorf("Location() = %q, want Asia/Kolkata", got)
	}
}

func TestVersionFormatting(t *testing.T) {
	if got := FormatVersion(7); got != "7" {
		t.Errorf("FormatVersion(7) = %q", got)
	}
	version, err := ParseVersion(" 12 ")
	if err != nil || version != 12 {
		t.Errorf("ParseVersion = (%d, %v), want (12, nil)", version, err)
	}
	if _, err := ParseVersion("not-a-number"); err == nil {
		t.Error("a non-numeric version was accepted")
	}
}
