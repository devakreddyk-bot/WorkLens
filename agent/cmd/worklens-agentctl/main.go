// Command worklens-agentctl installs, enrols and diagnoses the WorkLens agent.
//
// Separated from the agent itself so the thing that runs continuously on an employee's laptop has
// no code path that can install a scheduled task, write a credential, or delete a buffer. The
// agent reads its configuration; only this tool writes it.
//
// Subcommands:
//
//	enroll     consume a one-time enrolment token and write the device credential
//	install    register the logon scheduled task (Windows)
//	uninstall  remove the scheduled task
//	unenroll   delete the credential and stop capturing
//	status     what is configured and how far behind the buffer is
//	doctor     check everything that commonly goes wrong, and say what to do about it
//	notice     print the transparency notice this installation would show
//	version    print the version
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/worklens/worklens/agent/internal/config"
	"github.com/worklens/worklens/agent/internal/notice"
	"github.com/worklens/worklens/agent/internal/signing"
	"github.com/worklens/worklens/agent/internal/store"
	"github.com/worklens/worklens/agent/internal/uploader"
)

var version = "dev"

func main() {
	os.Exit(run(os.Args[1:]))
}

func usage() {
	fmt.Fprint(os.Stderr, `worklens-agentctl — install, enrol and diagnose the WorkLens agent

Usage:
  worklens-agentctl <command> [flags]

Commands:
  enroll      Consume a one-time enrolment token and write the device credential
  install     Register the agent to start at logon (Windows)
  uninstall   Remove the scheduled task
  unenroll    Delete this device's credential; the agent stops capturing
  status      Show what is configured and whether uploads are keeping up
  doctor      Diagnose the usual problems and say how to fix them
  notice      Print the transparency notice this installation shows employees
  version     Print the version

Run 'worklens-agentctl <command> -h' for a command's flags.
`)
}

func run(args []string) int {
	if len(args) == 0 {
		usage()
		return 2
	}

	command, rest := args[0], args[1:]

	var err error
	switch command {
	case "enroll":
		err = cmdEnroll(rest)
	case "install":
		err = cmdInstall(rest)
	case "uninstall":
		err = cmdUninstall(rest)
	case "unenroll":
		err = cmdUnenroll(rest)
	case "status":
		err = cmdStatus(rest)
	case "doctor":
		// doctor reports problems through its own exit code, because a monitoring tool that
		// exits 0 while misconfigured is exactly what a deployment script must not see.
		return cmdDoctor(rest)
	case "notice":
		err = cmdNotice(rest)
	case "version":
		fmt.Printf("worklens-agentctl %s (%s/%s, %s)\n", version, runtime.GOOS, runtime.GOARCH, runtime.Version())
		return 0
	case "-h", "--help", "help":
		usage()
		return 0
	default:
		fmt.Fprintf(os.Stderr, "worklens-agentctl: unknown command %q\n\n", command)
		usage()
		return 2
	}

	if err != nil {
		fmt.Fprintf(os.Stderr, "worklens-agentctl: %v\n", err)
		return 1
	}
	return 0
}

// resolve loads the paths and settings a subcommand needs.
//
// requireSettings is false for `install`, which legitimately runs before an API URL is configured.
func resolve(dataDir string, requireSettings bool) (config.Paths, config.Settings, error) {
	paths, err := config.ResolvePaths(dataDir)
	if err != nil {
		return config.Paths{}, config.Settings{}, err
	}

	settings, err := config.LoadSettings(paths.ConfigFile)
	if err != nil && requireSettings {
		return paths, config.Settings{}, err
	}
	return paths, settings, nil
}

// ---------------------------------------------------------------------------
// enroll
// ---------------------------------------------------------------------------

func cmdEnroll(args []string) error {
	fs := flag.NewFlagSet("enroll", flag.ExitOnError)
	token := fs.String("token", "", "the one-time enrolment token (wlen_...), from Settings > Devices in the dashboard")
	apiURL := fs.String("api-url", "", "the API base URL; required on a first enrolment, then remembered")
	dataDir := fs.String("data-dir", "", "override the agent's data directory")
	force := fs.Bool("force", false, "replace an existing credential")
	_ = fs.Parse(args)

	if strings.TrimSpace(*token) == "" {
		return errors.New("enroll: --token is required. Generate one in the dashboard under Settings > Devices")
	}
	if !strings.HasPrefix(*token, "wlen_") {
		// Caught here rather than by the server, because the usual cause is a copy-paste that
		// picked up the surrounding text, and a local message is faster than a 401.
		return fmt.Errorf("enroll: a token starts with wlen_; %q does not look like one", truncateForDisplay(*token))
	}

	paths, err := config.ResolvePaths(*dataDir)
	if err != nil {
		return err
	}

	settings, err := config.LoadSettings(paths.ConfigFile)
	if err != nil {
		// No usable configuration yet. An --api-url makes this a complete first-run enrolment.
		if strings.TrimSpace(*apiURL) == "" {
			return fmt.Errorf("enroll: %w\n\nPass --api-url on a first enrolment", err)
		}
		settings = config.Settings{APIBaseURL: strings.TrimSpace(*apiURL)}
	}
	if strings.TrimSpace(*apiURL) != "" {
		settings.APIBaseURL = strings.TrimSpace(*apiURL)
	}
	if err := settings.Validate(); err != nil {
		return err
	}

	if existing, err := config.LoadCredentials(paths.CredentialsFile); err == nil && !*force {
		return fmt.Errorf(
			"enroll: this device is already enrolled as %s. Re-enrolling creates a second device "+
				"and the timesheet is split across both; pass --force only if that is what you want",
			existing.DeviceID)
	}

	pins := uploader.DisabledPinSet()
	if settings.PinningEnabled() {
		configured := settings.TLSPins
		if len(configured) == 0 {
			configured = uploader.DefaultPins()
		}
		if pins, err = uploader.NewPinSet(configured); err != nil {
			return err
		}
	}

	client, err := uploader.NewClient(uploader.Options{
		BaseURL:   settings.APIBaseURL,
		Pins:      pins,
		UserAgent: "worklens-agentctl/" + version,
	})
	if err != nil {
		return err
	}

	hostname, _ := os.Hostname()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	fmt.Printf("Enrolling %s with %s…\n", hostname, settings.APIBaseURL)

	response, err := client.Enroll(ctx, uploader.EnrollRequest{
		Token:              strings.TrimSpace(*token),
		Hostname:           hostname,
		OS:                 runtime.GOOS,
		OSVersion:          osVersion(),
		AgentVersion:       version,
		MachineFingerprint: machineFingerprint(hostname),
	})
	if err != nil {
		return explainEnrollFailure(err)
	}

	creds := config.Credentials{
		DeviceID:   response.DeviceID,
		Secret:     response.DeviceSecret,
		OrgID:      response.OrgID,
		EmployeeID: response.EmployeeID,
		KeyVersion: response.KeyVersion,
		EnrolledAt: time.Now().UTC().Format(time.RFC3339),
	}
	if err := config.SaveCredentials(paths.CredentialsFile, creds); err != nil {
		return err
	}
	if err := config.SaveSettings(paths.ConfigFile, settings); err != nil {
		return err
	}

	// Cache the policy that came back, so the first sample after enrolment honours the real
	// configuration rather than the least-invasive placeholder.
	if len(response.Config) > 0 {
		if err := cacheConfig(paths, response.Config, response.ConfigVersion); err != nil {
			fmt.Fprintf(os.Stderr, "warning: could not cache the monitoring configuration: %v\n", err)
		}
	}

	// The device id is printed; the secret never is. It is in credentials.json at mode 0600 and
	// nowhere else — printing it would put it in a terminal scrollback and, sooner or later, a
	// support ticket.
	fmt.Printf("\nEnrolled.\n  Device:   %s\n  Employee: %s\n  Credential: %s\n",
		creds.DeviceID, creds.EmployeeID, paths.CredentialsFile)
	fmt.Printf("\nNext: worklens-agentctl install    (start the agent at logon)\n")
	return nil
}

// explainEnrollFailure turns a server error into something actionable.
//
// Enrolment is where a deployer meets this software for the first time; a bare "HTTP 409" is a
// support call, while "that token has already been used" is a fix.
func explainEnrollFailure(err error) error {
	var apiErr *uploader.APIError
	if !errors.As(err, &apiErr) {
		if errors.Is(err, uploader.ErrPinMismatch) {
			return fmt.Errorf(
				"enroll: the server's certificate did not match any pinned authority.\n"+
					"  This is expected behind a corporate TLS-inspection proxy. Either add the\n"+
					"  proxy's authority to tls_pins in config.json, or set WORKLENS_TLS_PINNING=off\n"+
					"  after confirming with whoever runs the proxy.\n\n  %w", err)
		}
		return fmt.Errorf("enroll: could not reach %w", err)
	}

	switch apiErr.Code {
	case uploader.CodeEnrollmentTokenUsed:
		return errors.New("enroll: that enrolment token has already been used. " +
			"Tokens are single-use; generate a new one in the dashboard")
	case uploader.CodeEnrollmentTokenExpired:
		return errors.New("enroll: that enrolment token has expired. Generate a new one in the dashboard")
	case uploader.CodeInvalidSignature, "INVALID_TOKEN", "NOT_FOUND":
		return errors.New("enroll: the server did not recognise that token. Check it was copied in full")
	default:
		return fmt.Errorf("enroll: %w", err)
	}
}

func cacheConfig(paths config.Paths, raw []byte, version int) error {
	buffer, err := store.Open(paths.BufferFile, store.Options{})
	if err != nil {
		return err
	}
	defer func() { _ = buffer.Close() }()

	ctx := context.Background()
	if err := buffer.SetMeta(ctx, store.MetaConfigJSON, string(raw)); err != nil {
		return err
	}
	return buffer.SetMeta(ctx, store.MetaConfigVersion, config.FormatVersion(version))
}

// ---------------------------------------------------------------------------
// unenroll
// ---------------------------------------------------------------------------

func cmdUnenroll(args []string) error {
	fs := flag.NewFlagSet("unenroll", flag.ExitOnError)
	dataDir := fs.String("data-dir", "", "override the agent's data directory")
	keepBuffer := fs.Bool("keep-buffer", false, "keep unsent events instead of deleting them")
	_ = fs.Parse(args)

	paths, err := config.ResolvePaths(*dataDir)
	if err != nil {
		return err
	}

	if err := config.DeleteCredentials(paths.CredentialsFile); err != nil {
		return err
	}

	// The buffer holds window titles. Leaving it behind after unenrolment would leave personal
	// data on the machine with nothing that will ever upload or delete it, so it goes unless the
	// operator explicitly wants it kept for diagnosis.
	if !*keepBuffer {
		for _, path := range []string{paths.BufferFile, paths.BufferFile + "-wal", paths.BufferFile + "-shm"} {
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				fmt.Fprintf(os.Stderr, "warning: could not remove %s: %v\n", path, err)
			}
		}
		if err := os.RemoveAll(paths.ScreenshotDir); err != nil {
			fmt.Fprintf(os.Stderr, "warning: could not remove the screenshot queue: %v\n", err)
		}
	}

	fmt.Println("Unenrolled. The agent will capture nothing until it is enrolled again.")
	if *keepBuffer {
		fmt.Printf("The local buffer was kept at %s and still contains unsent activity.\n", paths.BufferFile)
	}
	fmt.Println("Run 'worklens-agentctl uninstall' to stop it starting at logon.")
	return nil
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

func cmdStatus(args []string) error {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	dataDir := fs.String("data-dir", "", "override the agent's data directory")
	_ = fs.Parse(args)

	paths, settings, err := resolve(*dataDir, false)
	if err != nil {
		return err
	}

	fmt.Printf("WorkLens agent %s\n\n", version)
	fmt.Printf("  Data directory   %s\n", paths.DataDir)
	if settings.APIBaseURL == "" {
		fmt.Printf("  API              (not configured)\n")
	} else {
		fmt.Printf("  API              %s\n", settings.APIBaseURL)
	}
	fmt.Printf("  TLS pinning      %s\n", pinningDescription(settings))

	creds, credErr := config.LoadCredentials(paths.CredentialsFile)
	switch {
	case errors.Is(credErr, config.ErrNotEnrolled):
		fmt.Printf("  Enrolment        not enrolled — nothing is being captured\n")
	case credErr != nil:
		fmt.Printf("  Enrolment        unusable credential: %v\n", credErr)
	default:
		fmt.Printf("  Enrolment        device %s (employee %s, enrolled %s)\n",
			creds.DeviceID, creds.EmployeeID, creds.EnrolledAt)
	}

	buffer, err := store.Open(paths.BufferFile, store.Options{})
	if err != nil {
		fmt.Printf("  Buffer           unavailable: %v\n", err)
		return nil
	}
	defer func() { _ = buffer.Close() }()

	ctx := context.Background()
	stats, err := buffer.Stats(ctx)
	if err != nil {
		fmt.Printf("  Buffer           unreadable: %v\n", err)
		return nil
	}

	fmt.Printf("  Buffer           %d event(s), %d screenshot(s), %.1f KB on disk\n",
		stats.Events, stats.Screenshots, float64(stats.FileBytes)/1024)
	if !stats.OldestCapturedAt.IsZero() {
		fmt.Printf("  Oldest unsent    %s (%s ago)\n",
			stats.OldestCapturedAt.Local().Format(time.RFC3339),
			time.Since(stats.OldestCapturedAt).Round(time.Minute))
	}

	if value, ok, _ := buffer.GetMeta(ctx, store.MetaLastUploadAt); ok {
		fmt.Printf("  Last upload      %s\n", value)
	} else {
		fmt.Printf("  Last upload      never\n")
	}
	if value, ok, _ := buffer.GetMeta(ctx, store.MetaConfigVersion); ok {
		fmt.Printf("  Config version   %s\n", value)
	}
	if acknowledged, _ := notice.Acknowledged(ctx, buffer); acknowledged {
		fmt.Printf("  Notice           acknowledged\n")
	} else {
		fmt.Printf("  Notice           NOT acknowledged — capture will not start\n")
	}

	return nil
}

func pinningDescription(settings config.Settings) string {
	if !settings.PinningEnabled() {
		return "DISABLED (WORKLENS_TLS_PINNING=off or tls_pinning_enabled=false)"
	}
	if len(settings.TLSPins) > 0 {
		return fmt.Sprintf("enabled, %d custom pin(s)", len(settings.TLSPins))
	}
	return fmt.Sprintf("enabled, %d built-in Amazon root pin(s)", len(uploader.DefaultPins()))
}

// ---------------------------------------------------------------------------
// notice
// ---------------------------------------------------------------------------

func cmdNotice(args []string) error {
	fs := flag.NewFlagSet("notice", flag.ExitOnError)
	dataDir := fs.String("data-dir", "", "override the agent's data directory")
	_ = fs.Parse(args)

	paths, settings, err := resolve(*dataDir, false)
	if err != nil {
		return err
	}

	// Rendered from the cached policy, so what is printed is what an employee on this machine would
	// actually be shown — the point of this subcommand is that a deployer can read it before
	// rolling out, and a generic version would defeat that.
	monitoring := config.LeastInvasiveConfig()
	if buffer, err := store.Open(paths.BufferFile, store.Options{}); err == nil {
		defer func() { _ = buffer.Close() }()
		if encoded, ok, _ := buffer.GetMeta(context.Background(), store.MetaConfigJSON); ok {
			if cached, err := config.UnmarshalMonitoringConfig(encoded); err == nil {
				monitoring = cached
			}
		}
	}

	fmt.Print(notice.Text(notice.Details{
		OrgName:             settings.NoticeOrgName,
		ContactName:         settings.NoticeContactName,
		ContactEmail:        settings.NoticeContactEmail,
		DashboardURL:        settings.DashboardURL,
		CaptureWindowTitles: monitoring.CaptureWindowTitles,
		CaptureURLs:         monitoring.CaptureURLs,
		CaptureScreenshots:  monitoring.ScreenshotEnabled,
		BlurScreenshots:     monitoring.ScreenshotBlur,
		ScreenshotInterval:  monitoring.ScreenshotInterval(),
		IdleThreshold:       monitoring.IdleThreshold(),
		WorkHoursOnly:       monitoring.WorkHoursOnly,
		WorkHours:           monitoring.WorkHoursStart + " to " + monitoring.WorkHoursEnd,
	}))
	return nil
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// machineFingerprint is a stable, non-identifying hash used to recognise a re-enrolment of the same
// laptop. Derived from the hostname only: enough to spot a duplicate, not enough to identify a
// person, and deliberately not a hardware serial.
func machineFingerprint(hostname string) string {
	return signing.Sign("worklens-machine-fingerprint", signing.Request{
		Method: "FINGERPRINT", Path: hostname, Timestamp: 0, Nonce: runtime.GOOS,
	})[:32]
}

// truncateForDisplay shortens a value for an error message.
//
// Used on a rejected token: showing the whole thing would put a credential in a terminal
// scrollback, and showing none of it makes a typo impossible to spot.
func truncateForDisplay(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= 12 {
		return value
	}
	return value[:12] + "…"
}
