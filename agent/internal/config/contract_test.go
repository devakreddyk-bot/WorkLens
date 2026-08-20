package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The device-config contract, mirroring contracts/device-config-response.json.
//
// This is the agent half of a two-sided agreement; backend/test/handlers/deviceConfigContract.test.ts
// is the other. The file exists because these two sides disagreed and nothing detected it: the
// daemon passed the entire response body to a parser expecting the settings at the top level, so
// every setting decoded to zero and the agent rejected its own configuration on every poll. It
// failed safe and silently, which is the worst combination — an owner could turn screenshots off,
// see the change saved, and have it reach no device at all.
type configContract struct {
	Response json.RawMessage `json:"response"`
	Expected struct {
		ConfigVersionAfterParse int      `json:"configVersionAfterParse"`
		EnvelopeKeys            []string `json:"envelopeKeys"`
		RequiredConfigKeys      []string `json:"requiredConfigKeys"`
	} `json:"expected"`
}

func loadConfigContract(t *testing.T) configContract {
	t.Helper()
	path := filepath.Join("..", "..", "..", "contracts", "device-config-response.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	var contract configContract
	if err := json.Unmarshal(raw, &contract); err != nil {
		t.Fatalf("parsing %s: %v", path, err)
	}
	if len(contract.Response) == 0 {
		t.Fatalf("%s has no response body", path)
	}
	return contract
}

// The whole point: the shipped parser must accept the shipped server's shape.
func TestConfigContractParsesAndValidates(t *testing.T) {
	contract := loadConfigContract(t)

	got, err := UnmarshalConfigResponse(contract.Response)
	if err != nil {
		t.Fatalf("UnmarshalConfigResponse: %v", err)
	}

	// Before this was fixed, every one of these was its zero value and Validate() failed on the
	// first of them. Asserted individually rather than by struct equality so a regression names the
	// field that broke.
	if got.SampleIntervalSeconds != 60 {
		t.Errorf("sample_interval_seconds = %d, want 60", got.SampleIntervalSeconds)
	}
	if got.IdleThresholdSeconds != 300 {
		t.Errorf("idle_threshold_seconds = %d, want 300", got.IdleThresholdSeconds)
	}
	if !got.CaptureWindowTitles {
		t.Error("capture_window_titles = false, want true")
	}
	if got.CaptureURLs {
		t.Error("capture_urls = true, want false")
	}
	if got.ScreenshotEnabled {
		t.Error("screenshot_enabled = true, want false")
	}
	if !got.ScreenshotBlur {
		t.Error("screenshot_blur = false, want true")
	}
	if !got.WorkHoursOnly {
		t.Error("work_hours_only = false, want true")
	}
	if got.WorkHoursStart != "09:00" || got.WorkHoursEnd != "17:30" {
		t.Errorf("work hours = %q-%q, want 09:00-17:30", got.WorkHoursStart, got.WorkHoursEnd)
	}
	if len(got.WorkDays) != 5 {
		t.Errorf("work_days = %v, want 5 entries", got.WorkDays)
	}
	if len(got.ExcludedApps) != 2 || len(got.ExcludedURLPatterns) != 2 {
		t.Errorf("exclusions = %v / %v, want 2 each", got.ExcludedApps, got.ExcludedURLPatterns)
	}
	if got.RetentionDaysEvents != 90 || got.RetentionDaysScreenshots != 30 {
		t.Errorf("retention = %d/%d, want 90/30", got.RetentionDaysEvents, got.RetentionDaysScreenshots)
	}

	// The timezone is the field whose absence would have failed validation for a second,
	// independent reason. It is the employee's zone, not a monitoring_config column.
	if got.Timezone != "Asia/Kolkata" {
		t.Errorf("timezone = %q, want Asia/Kolkata", got.Timezone)
	}

	// From the envelope, not from the nested object.
	if got.ConfigVersion != contract.Expected.ConfigVersionAfterParse {
		t.Errorf("config_version = %d, want %d", got.ConfigVersion, contract.Expected.ConfigVersionAfterParse)
	}

	if err := got.Validate(); err != nil {
		t.Fatalf("the contract response does not satisfy Validate(): %v", err)
	}

	// Location falls back to UTC rather than erroring, so assert it actually resolved the zone.
	if loc := got.Location(); loc == nil || loc.String() != "Asia/Kolkata" {
		t.Errorf("Location() = %v, want Asia/Kolkata", loc)
	}
}

// Guards the contract file itself, so a well-meaning edit cannot quietly flatten the envelope or
// drop the timezone and leave both sides agreeing on the wrong thing.
func TestConfigContractFileKeepsItsShape(t *testing.T) {
	contract := loadConfigContract(t)

	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(contract.Response, &envelope); err != nil {
		t.Fatalf("response is not an object: %v", err)
	}
	for _, key := range contract.Expected.EnvelopeKeys {
		if _, ok := envelope[key]; !ok {
			t.Errorf("the response envelope is missing %q", key)
		}
	}

	var settings map[string]json.RawMessage
	if err := json.Unmarshal(envelope["config"], &settings); err != nil {
		t.Fatalf("config is not an object: %v", err)
	}
	for _, key := range contract.Expected.RequiredConfigKeys {
		if _, ok := settings[key]; !ok {
			t.Errorf("the config object is missing %q", key)
		}
	}

	// The settings must NOT be at the top level. This is the exact mistake the file documents, and
	// asserting its absence is what stops somebody "simplifying" the fixture back into the bug.
	if _, flattened := envelope["sample_interval_seconds"]; flattened {
		t.Error("settings appear at the top level; they belong nested under `config`")
	}
	// And config_version must NOT be inside the settings: presentAgentConfig deliberately omits it.
	if _, nested := settings["config_version"]; nested {
		t.Error("config_version appears inside `config`; it belongs in the envelope")
	}
}

// A regression test for the specific failure, kept because the bug was silent rather than loud.
func TestFlattenedResponseWouldNotValidate(t *testing.T) {
	// What the daemon used to do: hand the envelope to the bare-configuration parser.
	contract := loadConfigContract(t)

	stale, err := UnmarshalMonitoringConfig(string(contract.Response))
	if err != nil {
		t.Fatalf("UnmarshalMonitoringConfig on the envelope: %v", err)
	}

	// It parses — that is why nothing caught it — and produces a configuration with the version set
	// and nothing else, which Validate() then refuses.
	if stale.ConfigVersion != contract.Expected.ConfigVersionAfterParse {
		t.Errorf("config_version = %d, want it to have matched", stale.ConfigVersion)
	}
	if stale.SampleIntervalSeconds != 0 {
		t.Errorf("sample_interval_seconds = %d, expected the old bug to yield 0", stale.SampleIntervalSeconds)
	}
	if err := stale.Validate(); err == nil {
		t.Fatal("the flattened parse validated; this test no longer describes the bug it documents")
	}
}
