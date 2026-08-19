package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/worklens/worklens/agent/internal/config"
	"github.com/worklens/worklens/agent/internal/notice"
	"github.com/worklens/worklens/agent/internal/store"
	"github.com/worklens/worklens/agent/internal/uploader"
)

// doctor exists because the agent is deliberately quiet.
//
// It captures nothing when it is not enrolled, nothing before the notice is acknowledged, and
// nothing outside working hours — all correct, and all indistinguishable from "broken" to whoever
// deployed it. Every check below therefore reports not only what is wrong but what to do about it;
// a diagnostic that says "FAIL: not enrolled" and stops has moved the problem rather than solved it.
//
// Exit codes: 0 when everything passed, 1 when anything failed. Warnings do not fail, so a
// deployment script can gate on this without being blocked by, say, a full buffer that is merely
// waiting for network.

type severity int

const (
	sevPass severity = iota
	sevWarn
	sevFail
)

func (s severity) marker() string {
	switch s {
	case sevPass:
		return "  ok  "
	case sevWarn:
		return " warn "
	default:
		return " FAIL "
	}
}

type check struct {
	name     string
	severity severity
	detail   string
	// remedy is what to actually do. Empty for a pass.
	remedy string
}

type report struct {
	checks []check
}

func (r *report) add(name string, sev severity, detail, remedy string) {
	r.checks = append(r.checks, check{name: name, severity: sev, detail: detail, remedy: remedy})
}

func (r *report) pass(name, detail string)         { r.add(name, sevPass, detail, "") }
func (r *report) warn(name, detail, remedy string) { r.add(name, sevWarn, detail, remedy) }
func (r *report) fail(name, detail, remedy string) { r.add(name, sevFail, detail, remedy) }

func (r *report) failed() bool {
	for _, c := range r.checks {
		if c.severity == sevFail {
			return true
		}
	}
	return false
}

func (r *report) print() {
	fmt.Printf("WorkLens agent diagnostics — %s %s/%s\n\n", version, runtime.GOOS, runtime.GOARCH)

	width := 0
	for _, c := range r.checks {
		if len(c.name) > width {
			width = len(c.name)
		}
	}

	var remedies []check
	for _, c := range r.checks {
		fmt.Printf("[%s] %-*s  %s\n", c.severity.marker(), width, c.name, c.detail)
		if c.remedy != "" {
			remedies = append(remedies, c)
		}
	}

	if len(remedies) > 0 {
		fmt.Printf("\nWhat to do:\n")
		for _, c := range remedies {
			fmt.Printf("\n  %s\n", c.name)
			for _, line := range strings.Split(c.remedy, "\n") {
				fmt.Printf("    %s\n", line)
			}
		}
	}

	fmt.Println()
	if r.failed() {
		fmt.Println("Result: problems found.")
		return
	}
	fmt.Println("Result: healthy.")
}

func cmdDoctor(args []string) int {
	fs := flag.NewFlagSet("doctor", flag.ExitOnError)
	dataDir := fs.String("data-dir", "", "override the agent's data directory")
	skipNetwork := fs.Bool("offline", false, "skip the checks that need network access")
	_ = fs.Parse(args)

	r := &report{}

	// ---- paths and settings ------------------------------------------------
	paths, pathErr := config.ResolvePaths(*dataDir)
	if pathErr != nil {
		r.fail("Data directory", pathErr.Error(),
			"On Windows the agent runs as a logon task in the user's own session, so\n"+
				"LOCALAPPDATA must be set. An empty LOCALAPPDATA usually means it was\n"+
				"installed as a service, where it cannot observe the desktop at all.")
		r.print()
		return 1
	}
	r.pass("Data directory", paths.DataDir)

	settings, settingsErr := config.LoadSettings(paths.ConfigFile)
	if settingsErr != nil {
		r.fail("Configuration", settingsErr.Error(),
			"Run: worklens-agentctl enroll --token wlen_... --api-url https://.../v1")
	} else {
		r.pass("Configuration", settings.APIBaseURL)
	}

	// ---- the notice, and whether it can be shown ---------------------------
	if settings.NoticeIsComplete() {
		r.pass("Notice details", "organisation and contact are set")
	} else {
		r.warn("Notice details", "no organisation name or contact address",
			"Employees are shown a notice naming who is monitoring them and who to ask.\n"+
				"Set notice_org_name and notice_contact_email in:\n  "+paths.ConfigFile+"\n"+
				"Preview what they will see with: worklens-agentctl notice")
	}

	if _, err := notice.NewPresenter(); err != nil {
		r.warn("Notice display", err.Error(),
			"The agent cannot display the first-run notice on this platform, so capture\n"+
				"will not start. This is expected off Windows.")
	} else {
		r.pass("Notice display", "the notice can be displayed")
	}

	// ---- TLS pinning -------------------------------------------------------
	if settings.PinningEnabled() {
		pins := settings.TLSPins
		if len(pins) == 0 {
			pins = uploader.DefaultPins()
		}
		if _, err := uploader.NewPinSet(pins); err != nil {
			r.fail("TLS pinning", err.Error(),
				"A pin that cannot be parsed means every connection fails. Pins are\n"+
					"base64 or hex SHA-256 SPKI digests; check tls_pins in config.json.")
		} else {
			r.pass("TLS pinning", fmt.Sprintf("enabled, %d pin(s)", len(pins)))
		}
	} else {
		r.warn("TLS pinning", "DISABLED",
			"Connections are still encrypted and verified against the system trust store,\n"+
				"but a corporate interception proxy or a compromised CA would not be detected.\n"+
				"Remove WORKLENS_TLS_PINNING=off, or tls_pinning_enabled from config.json, to re-enable.")
	}

	// ---- enrolment ---------------------------------------------------------
	creds, credErr := config.LoadCredentials(paths.CredentialsFile)
	switch {
	case errors.Is(credErr, config.ErrNotEnrolled):
		r.fail("Enrolment", "not enrolled — nothing will be captured",
			"Generate a token in the dashboard under Settings > Devices, then run:\n"+
				"  worklens-agentctl enroll --token wlen_...")
	case credErr != nil:
		r.fail("Enrolment", credErr.Error(),
			"The credential file is unusable. Re-enrol with a fresh token:\n"+
				"  worklens-agentctl enroll --token wlen_... --force")
	default:
		r.pass("Enrolment", fmt.Sprintf("device %s, key version %d", creds.DeviceID, creds.KeyVersion))
	}

	// ---- the buffer, the notice acknowledgment, and how far behind it is ----
	buffer, bufErr := store.Open(paths.BufferFile, store.Options{})
	if bufErr != nil {
		r.fail("Local buffer", bufErr.Error(),
			"The agent cannot record anything without its buffer. Check the disk has space\n"+
				"and that antivirus is not locking:\n  "+paths.BufferFile)
	} else {
		defer func() { _ = buffer.Close() }()
		ctx := context.Background()

		if stats, err := buffer.Stats(ctx); err != nil {
			r.fail("Local buffer", err.Error(), "The buffer exists but cannot be read; it may be corrupt.")
		} else {
			detail := fmt.Sprintf("%d event(s), %d screenshot(s), %.1f KB",
				stats.Events, stats.Screenshots, float64(stats.FileBytes)/1024)

			// A backlog with an old head means uploads are not getting through, which is the single
			// most useful thing this command can surface.
			if !stats.OldestCapturedAt.IsZero() && time.Since(stats.OldestCapturedAt) > 24*time.Hour {
				r.warn("Local buffer", detail+fmt.Sprintf(", oldest %s old",
					time.Since(stats.OldestCapturedAt).Round(time.Hour)),
					"Events have been waiting over a day, so uploads are failing. Check the\n"+
						"API reachability check below, and the agent log:\n  "+paths.LogFile)
			} else {
				r.pass("Local buffer", detail)
			}
		}

		if acknowledged, err := notice.Acknowledged(ctx, buffer); err == nil && acknowledged {
			r.pass("Notice acknowledged", "yes — capture may proceed")
		} else if err == nil {
			r.warn("Notice acknowledged", "not yet — capture will not start",
				"The employee is shown the notice at the agent's next start and has to accept it.\n"+
					"Nothing is captured until they do. This is by design.")
		}

		if value, ok, _ := buffer.GetMeta(ctx, store.MetaConfigVersion); ok {
			r.pass("Monitoring policy", "config version "+value)
		} else {
			r.warn("Monitoring policy", "none cached yet",
				"The agent uses the least-invasive defaults until it has fetched the\n"+
					"organisation's policy: titles off, URLs off, screenshots off, work hours only.")
		}
	}

	// ---- the clock ---------------------------------------------------------
	// Checked before the network, because a wrong clock makes every signed request fail with an
	// error that looks like an authentication problem.
	if !*skipNetwork && settings.APIBaseURL != "" {
		checkClock(r, settings)
	}

	// ---- reachability and the pin --------------------------------------------
	if *skipNetwork {
		r.warn("API reachability", "skipped (--offline)", "")
	} else if settings.APIBaseURL != "" {
		checkReachability(r, settings)
	}

	// ---- the scheduled task -------------------------------------------------
	checkScheduledTask(r)

	r.print()
	if r.failed() {
		return 1
	}
	return 0
}

// checkClock compares the local clock against the server's Date header.
//
// The server rejects a request whose timestamp is more than 300 seconds out, and reports it with a
// distinct error code for exactly this reason: a laptop with a wrong clock is a support call, not an
// authentication failure. Finding it here turns a mystifying 401 into "your clock is 47 minutes
// fast".
func checkClock(r *report, settings config.Settings) {
	parsed, err := url.Parse(settings.APIBaseURL)
	if err != nil {
		return
	}

	client := &http.Client{Timeout: 10 * time.Second}
	request, err := http.NewRequest(http.MethodHead, parsed.Scheme+"://"+parsed.Host+"/", nil)
	if err != nil {
		return
	}

	before := time.Now()
	response, err := client.Do(request)
	if err != nil {
		// Reachability is reported by its own check; nothing to add here.
		return
	}
	defer func() { _ = response.Body.Close() }()

	serverDate, err := http.ParseTime(response.Header.Get("Date"))
	if err != nil {
		return
	}

	// Split the request duration so a slow link is not read as clock skew.
	local := before.Add(time.Since(before) / 2)
	skew := local.Sub(serverDate)
	if skew < 0 {
		skew = -skew
	}

	switch {
	case skew > 300*time.Second:
		r.fail("Clock", fmt.Sprintf("this machine is %s out from the server", skew.Round(time.Second)),
			"Every signed request will be rejected until this is corrected. On Windows:\n"+
				"  w32tm /resync\n"+
				"If that fails, check the Windows Time service is running and set to automatic.")
	case skew > 60*time.Second:
		r.warn("Clock", fmt.Sprintf("this machine is %s out from the server", skew.Round(time.Second)),
			"Requests still succeed, but the margin is narrowing. Run: w32tm /resync")
	default:
		r.pass("Clock", fmt.Sprintf("within %s of the server", skew.Round(time.Second)))
	}
}

// checkReachability performs a real TLS handshake against the API, with the configured pins.
//
// A handshake rather than a ping, because the failure this most often catches is a pin mismatch
// behind a corporate interception proxy — and that only shows up when the certificate is actually
// verified.
func checkReachability(r *report, settings config.Settings) {
	parsed, err := url.Parse(settings.APIBaseURL)
	if err != nil {
		r.fail("API reachability", err.Error(), "Check api_base_url in config.json.")
		return
	}

	host := parsed.Hostname()
	port := parsed.Port()
	if port == "" {
		port = "443"
		if parsed.Scheme == "http" {
			port = "80"
		}
	}

	if _, err := net.LookupHost(host); err != nil {
		r.fail("DNS", fmt.Sprintf("cannot resolve %s", host),
			"The agent has no network, or a split-horizon DNS does not serve this name.\n"+
				"Check general connectivity first.")
		return
	}
	r.pass("DNS", host+" resolves")

	if parsed.Scheme != "https" {
		r.warn("API reachability", "not an https endpoint; skipping the TLS check", "")
		return
	}

	pins := uploader.DisabledPinSet()
	if settings.PinningEnabled() {
		configured := settings.TLSPins
		if len(configured) == 0 {
			configured = uploader.DefaultPins()
		}
		if parsedPins, err := uploader.NewPinSet(configured); err == nil {
			pins = parsedPins
		}
	}

	dialer := &net.Dialer{Timeout: 10 * time.Second}
	conn, err := tls.DialWithDialer(dialer, "tcp", net.JoinHostPort(host, port), pins.TLSConfig(host))
	if err != nil {
		if errors.Is(err, uploader.ErrPinMismatch) {
			r.fail("TLS handshake", "the certificate did not match any pinned authority",
				"This is what a corporate TLS-inspection proxy looks like. Either add the\n"+
					"proxy's authority to tls_pins in config.json, or — after confirming with\n"+
					"whoever runs it — set WORKLENS_TLS_PINNING=off.\n\n"+err.Error())
			return
		}
		r.fail("TLS handshake", err.Error(),
			"The agent cannot establish a verified connection. Check for a proxy, a firewall,\n"+
				"or a captive portal that has not been signed in to.")
		return
	}
	defer func() { _ = conn.Close() }()

	state := conn.ConnectionState()
	r.pass("TLS handshake", fmt.Sprintf("%s, %s, chain verified and pinned",
		tlsVersionName(state.Version), tls.CipherSuiteName(state.CipherSuite)))
}

func tlsVersionName(version uint16) string {
	switch version {
	case tls.VersionTLS13:
		return "TLS 1.3"
	case tls.VersionTLS12:
		return "TLS 1.2"
	default:
		return fmt.Sprintf("TLS 0x%04x", version)
	}
}

// checkScheduledTask confirms the agent will start at logon.
//
// A frequent and confusing failure: the agent works when run by hand and never appears after a
// restart, because nothing registered it.
func checkScheduledTask(r *report) {
	if runtime.GOOS != "windows" {
		r.warn("Autostart", "scheduled tasks are a Windows feature", "")
		return
	}

	output, err := exec.Command("schtasks", "/Query", "/TN", TaskName).CombinedOutput()
	if err != nil {
		r.fail("Autostart", fmt.Sprintf("the scheduled task %q is not registered", TaskName),
			"The agent will not start after a restart. Register it with:\n"+
				"  worklens-agentctl install")
		return
	}

	text := string(output)
	if strings.Contains(text, "Disabled") {
		r.fail("Autostart", "the scheduled task exists but is disabled",
			"Re-enable it with:\n  schtasks /Change /TN \""+TaskName+"\" /ENABLE")
		return
	}
	r.pass("Autostart", "registered to start at logon")
}
