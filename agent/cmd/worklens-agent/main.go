// Command worklens-agent is the monitoring agent that runs on an employee's laptop.
//
// # Startup order is a privacy control
//
// The sequence in run() is not arbitrary and must not be rearranged for convenience:
//
//  1. Settings and paths, so failures are reported to a real log.
//  2. The local buffer, and recovery of claims a previous crash left behind.
//  3. Credentials. Without them nothing is captured; the tray says so and the agent waits.
//  4. **The notice gate.** No capture goroutine is started until the employee has acknowledged
//     what is collected. Not "started and then filtered" — not started.
//  5. **The tray.** If it cannot be created the process exits non-zero, because an agent with no
//     visible indicator is covert monitoring software, which is the one thing this product must
//     never become.
//  6. Only then: the capture, upload and housekeeping loops.
//
// Steps 4 and 5 are the ones a well-meaning change would break. Both fail closed, and both have
// the reasoning recorded at the point where someone would be tempted to alter them.
//
// # Not a Windows service
//
// This runs as a per-user logon task, not a service (docs/PLAN.md deviation D5). A service lives in
// session 0, where GetForegroundWindow returns nothing useful, GetLastInputInfo reports no input,
// and a screen capture is blank — a service-based agent would report every employee as permanently
// idle. `worklens-agentctl install` registers the scheduled task.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/worklens/worklens/agent/internal/config"
	"github.com/worklens/worklens/agent/internal/logging"
	"github.com/worklens/worklens/agent/internal/notice"
	"github.com/worklens/worklens/agent/internal/platform"
	"github.com/worklens/worklens/agent/internal/store"
	"github.com/worklens/worklens/agent/internal/tray"
)

// version is set at build time with -ldflags "-X main.version=...". The default marks a build that
// did not come from the Makefile, which is worth being able to tell apart in a support log.
var version = "dev"

func main() {
	code := run()
	os.Exit(code)
}

// run returns the process exit code.
//
// Separate from main so every path can defer its cleanup; os.Exit in main would skip deferred
// closes and leave the buffer's WAL unfinalised.
func run() int {
	var (
		dataDir     = flag.String("data-dir", "", "override the agent's data directory (default: per-user application data)")
		showVersion = flag.Bool("version", false, "print the agent version and exit")
		logLevel    = flag.String("log-level", "", "override the configured log level (debug, info, warn, error)")
	)
	flag.Parse()

	if *showVersion {
		fmt.Printf("worklens-agent %s (%s/%s, %s)\n", version, runtime.GOOS, runtime.GOARCH, runtime.Version())
		return 0
	}

	// ---- 1. Settings and paths -------------------------------------------------
	paths, err := config.ResolvePaths(*dataDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "worklens-agent: %v\n", err)
		return 1
	}

	settings, err := config.LoadSettings(paths.ConfigFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "worklens-agent: %v\n", err)
		return 1
	}
	if *logLevel != "" {
		settings.LogLevel = *logLevel
	}

	// Settings.Validate has already accepted the level, so a parse failure here would be a bug
	// rather than bad input; the zero Level (info) is the safe reading either way.
	level, levelErr := logging.ParseLevel(settings.LogLevel)

	log, logErr := logging.New(logging.Options{
		Path:  paths.LogFile,
		Level: level,
	})
	// logging.New returns a usable logger even on error, so a read-only disk degrades to stderr
	// rather than preventing the agent from starting and explaining itself.
	defer func() { _ = log.Close() }()
	if logErr != nil {
		log.Warn("file logging is unavailable; logging to stderr only", logging.Any("error", logErr.Error()))
	}
	if levelErr != nil {
		log.Warn("could not parse the configured log level; using info", logging.Any("error", levelErr.Error()))
	}

	if !settings.NoticeIsComplete() {
		// A warning rather than a refusal. Making this fatal would tempt a deployer to strip the
		// notice out to get past the error, which is the opposite of the intended outcome.
		log.Warn("the first-run notice has no organisation name or contact address; " +
			"set notice_org_name and notice_contact_email in config.json before rolling this out")
	}

	log.Info("starting",
		logging.Any("version", version),
		logging.Any("os", runtime.GOOS),
		logging.Any("data_dir", paths.DataDir),
		logging.Any("api", settings.APIBaseURL),
	)

	if !settings.PinningEnabled() {
		// Logged on every startup, deliberately. A silent downgrade of certificate pinning would
		// be worse than not having it: nobody would know the fleet was exposed.
		log.Warn("TLS certificate pinning is DISABLED for this installation " +
			"(WORKLENS_TLS_PINNING=off or tls_pinning_enabled=false). " +
			"Connections are still encrypted and verified against the system trust store, " +
			"but a corporate interception proxy or a compromised CA would not be detected.")
	}

	// ---- 2. The local buffer ---------------------------------------------------
	buffer, err := store.Open(paths.BufferFile, store.Options{
		MaxBytes: settings.BufferMaxBytes,
		MaxAge:   time.Duration(settings.BufferMaxAgeHours) * time.Hour,
	})
	if err != nil {
		log.Error("could not open the local buffer", logging.Any("error", err.Error()))
		return 1
	}
	defer func() { _ = buffer.Close() }()

	// Claims left by a previous crash. Without this they stay claimed forever and the buffer grows
	// while appearing to have nothing to send.
	if events, screenshots, err := buffer.Recover(context.Background()); err != nil {
		log.Warn("could not recover stale upload claims", logging.Any("error", err.Error()))
	} else if events > 0 || screenshots > 0 {
		log.Info("recovered claims from a previous run",
			logging.Any("events", events), logging.Any("screenshots", screenshots))
	}

	// ---- 3. Credentials --------------------------------------------------------
	creds, credErr := config.LoadCredentials(paths.CredentialsFile)
	enrolled := credErr == nil
	if credErr != nil && !errors.Is(credErr, config.ErrNotEnrolled) {
		log.Error("the credential file is unusable", logging.Any("error", credErr.Error()))
		return 1
	}
	if enrolled {
		// AddSecret registers the device secret with the redactor, so it cannot reach the log even
		// through a field nobody anticipated.
		log.AddSecret(creds.Secret)
		log.Info("enrolled", logging.Any("device_id", creds.DeviceID), logging.Any("employee_id", creds.EmployeeID))
	} else {
		log.Warn("this device is not enrolled; nothing will be captured. " +
			"Run: worklens-agentctl enroll --token wlen_...")
	}

	// The cached monitoring policy. Least-invasive until the server has been reached, so an agent
	// that has never fetched a policy cannot collect more than the policy would allow.
	monitoring := loadCachedConfig(context.Background(), buffer, log)

	daemon := &daemon{
		log:        log,
		paths:      paths,
		settings:   settings,
		buffer:     buffer,
		creds:      creds,
		enrolled:   enrolled,
		monitoring: monitoring,
		version:    version,
	}

	// ---- 4. The notice gate ----------------------------------------------------
	// Evaluated before any capture goroutine exists. An agent that started capturing and filtered
	// afterwards would have already read the screen of somebody who had not been told.
	mayCapture := false
	if enrolled {
		outcome, err := daemon.runNoticeGate(context.Background())
		if err != nil {
			log.Error("could not present the monitoring notice", logging.Any("error", err.Error()))
			// Not fatal, but capture does not start: the employee has not been informed, so there
			// is nothing legitimate to collect.
		}
		mayCapture = outcome.MayCapture()
		if !mayCapture {
			log.Warn("the monitoring notice has not been acknowledged; capture will not start",
				logging.Any("outcome", outcome.String()))
		}
	}
	daemon.mayCapture = mayCapture

	// ---- 5. The tray -----------------------------------------------------------
	controller, trayErr := tray.Require(daemon.trayCallbacks())
	if trayErr != nil {
		if runtime.GOOS == "windows" {
			// Fatal. The agent's visibility is a promise to the person being monitored, and an
			// agent that cannot show itself must not run at all.
			log.Error("no system tray indicator could be created; refusing to run invisibly",
				logging.Any("error", trayErr.Error()))
			return 1
		}
		// On a developer machine there is no tray to create, and running headless is the point.
		log.Warn("running without a visible indicator (not a Windows build)",
			logging.Any("error", trayErr.Error()))
	}
	daemon.tray = controller

	// ---- 6. The loops ----------------------------------------------------------
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	plat, platErr := platform.New()
	if platErr != nil && daemon.mayCapture {
		log.Warn("this platform cannot observe the desktop; no activity will be captured",
			logging.Any("error", platErr.Error()))
		daemon.mayCapture = false
	}
	if plat != nil {
		defer func() { _ = plat.Close() }()
	}
	daemon.platform = plat

	// The tray owns the main goroutine on Windows, so the loops run behind it and Run returns when
	// the employee chooses Quit or a signal arrives.
	loopsDone := make(chan struct{})
	go func() {
		defer close(loopsDone)
		daemon.runLoops(ctx)
		// A finished set of loops means shutdown; unblock the tray so the process can exit.
		controller.Quit()
	}()

	if err := controller.Run(func() { daemon.publishState(ctx) }); err != nil {
		log.Error("the tray exited with an error", logging.Any("error", err.Error()))
	}

	// The tray returning means the employee chose Quit; cancel the loops and wait for them so the
	// buffer is closed cleanly and a session_end event is recorded.
	stop()
	select {
	case <-loopsDone:
	case <-time.After(10 * time.Second):
		log.Warn("the capture loops did not stop within 10s; exiting anyway")
	}

	log.Info("stopped")
	return 0
}

// loadCachedConfig reads the monitoring policy cached in the buffer.
//
// Falls back to the least-invasive configuration on anything unexpected. That direction is
// deliberate: a corrupt cache must not be able to widen what is collected.
func loadCachedConfig(ctx context.Context, buffer *store.Store, log *logging.Logger) config.MonitoringConfig {
	encoded, ok, err := buffer.GetMeta(ctx, store.MetaConfigJSON)
	if err != nil {
		log.Warn("could not read the cached monitoring configuration", logging.Any("error", err.Error()))
		return config.LeastInvasiveConfig()
	}
	if !ok {
		log.Info("no monitoring configuration cached yet; using the least-invasive defaults")
		return config.LeastInvasiveConfig()
	}

	cached, err := config.UnmarshalMonitoringConfig(encoded)
	if err != nil {
		log.Warn("the cached monitoring configuration is unreadable; using the least-invasive defaults",
			logging.Any("error", err.Error()))
		return config.LeastInvasiveConfig()
	}
	if err := cached.Validate(); err != nil {
		log.Warn("the cached monitoring configuration is invalid; using the least-invasive defaults",
			logging.Any("error", err.Error()))
		return config.LeastInvasiveConfig()
	}

	log.Info("using the cached monitoring configuration",
		logging.Any("config_version", cached.ConfigVersion))
	return cached
}

// runNoticeGate shows the first-run notice if it has not been acknowledged.
func (d *daemon) runNoticeGate(ctx context.Context) (notice.Outcome, error) {
	presenter, err := notice.NewPresenter()
	if err != nil {
		// No way to show the notice means no way to inform the employee, so capture must not
		// start. Ensure enforces that too — a missing Presenter is an error there, not a default —
		// but returning early here makes the reason legible.
		return notice.OutcomeNotAcknowledged, fmt.Errorf(
			"no way to display the monitoring notice on this platform: %w", err)
	}

	gate := notice.Gate{
		Store:     d.buffer,
		Presenter: presenter,
		Details:   d.noticeDetails(),
		Log:       d.log,
	}
	return gate.Ensure(ctx)
}

// noticeDetails describes this installation, so every line of the notice is true of it.
func (d *daemon) noticeDetails() notice.Details {
	return notice.Details{
		OrgName:             d.settings.NoticeOrgName,
		ContactName:         d.settings.NoticeContactName,
		ContactEmail:        d.settings.NoticeContactEmail,
		DashboardURL:        d.settings.DashboardURL,
		CaptureWindowTitles: d.monitoring.CaptureWindowTitles,
		CaptureURLs:         d.monitoring.CaptureURLs,
		CaptureScreenshots:  d.monitoring.ScreenshotEnabled,
		BlurScreenshots:     d.monitoring.ScreenshotBlur,
		ScreenshotInterval:  d.monitoring.ScreenshotInterval(),
		IdleThreshold:       d.monitoring.IdleThreshold(),
		WorkHoursOnly:       d.monitoring.WorkHoursOnly,
		WorkHours:           fmt.Sprintf("%s to %s", d.monitoring.WorkHoursStart, d.monitoring.WorkHoursEnd),
	}
}
