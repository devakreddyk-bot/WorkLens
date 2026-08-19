package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/worklens/worklens/agent/internal/capture"
	"github.com/worklens/worklens/agent/internal/config"
	"github.com/worklens/worklens/agent/internal/logging"
	"github.com/worklens/worklens/agent/internal/notice"
	"github.com/worklens/worklens/agent/internal/platform"
	"github.com/worklens/worklens/agent/internal/privacy"
	"github.com/worklens/worklens/agent/internal/screenshot"
	"github.com/worklens/worklens/agent/internal/signing"
	"github.com/worklens/worklens/agent/internal/store"
	"github.com/worklens/worklens/agent/internal/supervisor"
	"github.com/worklens/worklens/agent/internal/tray"
	"github.com/worklens/worklens/agent/internal/uploader"
)

// daemon holds the wiring. One struct rather than a pile of closures so the loops can be read in
// isolation and the mutable parts are visible in one place.
type daemon struct {
	log      *logging.Logger
	paths    config.Paths
	settings config.Settings
	buffer   *store.Store
	platform platform.Platform
	tray     tray.Controller
	version  string

	creds    config.Credentials
	enrolled bool
	// mayCapture is false until the notice has been acknowledged. Set once during startup and
	// only ever cleared afterwards (on revocation), never set — capture cannot begin later
	// without a restart, which keeps the gate a gate.
	mayCapture bool

	// mu guards everything below: the config poller writes it while the sampler and the tray read.
	mu         sync.RWMutex
	monitoring config.MonitoringConfig
	filter     *privacy.Filter
	client     *uploader.Client
	// lastReason is the privacy filter's most recent decision, shown in the tray so "why is it not
	// recording?" has an answer.
	lastReason   string
	lastUploadAt time.Time
	revoked      bool
	droppedTotal int64
}

// uploaderLog adapts logging.Logger to the interface the uploader declares.
//
// The uploader deliberately defines its own narrow Logger rather than importing this one, so it has
// no dependency on a logging implementation. This is the seam that costs: eight lines here instead
// of a package dependency there.
type uploaderLog struct{ log *logging.Logger }

func (u uploaderLog) Debug(msg string, fields ...any) { u.log.Debug(msg, pairsToFields(fields)...) }
func (u uploaderLog) Info(msg string, fields ...any)  { u.log.Info(msg, pairsToFields(fields)...) }
func (u uploaderLog) Warn(msg string, fields ...any)  { u.log.Warn(msg, pairsToFields(fields)...) }
func (u uploaderLog) Error(msg string, fields ...any) { u.log.Error(msg, pairsToFields(fields)...) }

// pairsToFields converts alternating key/value arguments into fields.
//
// A trailing odd argument is kept under a placeholder key rather than dropped: losing the last
// value of a log line silently is worse than an ugly key.
func pairsToFields(pairs []any) []logging.Field {
	fields := make([]logging.Field, 0, (len(pairs)+1)/2)
	for i := 0; i < len(pairs); i += 2 {
		key := fmt.Sprint(pairs[i])
		if i+1 < len(pairs) {
			fields = append(fields, logging.Any(key, pairs[i+1]))
			continue
		}
		fields = append(fields, logging.Any("_unpaired", key))
	}
	return fields
}

// buildClient constructs the upload client for the current settings.
func (d *daemon) buildClient() (*uploader.Client, error) {
	pins := uploader.DisabledPinSet()
	if d.settings.PinningEnabled() {
		configured := d.settings.TLSPins
		if len(configured) == 0 {
			configured = uploader.DefaultPins()
		}
		parsed, err := uploader.NewPinSet(configured)
		if err != nil {
			return nil, err
		}
		pins = parsed
	}

	return uploader.NewClient(uploader.Options{
		BaseURL:     d.settings.APIBaseURL,
		Credentials: signing.Credentials{DeviceID: d.creds.DeviceID, Secret: d.creds.Secret},
		Pins:        pins,
		Logger:      uploaderLog{log: d.log},
		UserAgent:   "worklens-agent/" + d.version + " (" + runtime.GOOS + ")",
	})
}

// runLoops starts every supervised loop and blocks until they stop.
func (d *daemon) runLoops(ctx context.Context) {
	if !d.enrolled {
		// Nothing to do but keep the tray responsive so the employee can read the notice and see
		// that nothing is being recorded.
		d.publishState(ctx)
		<-ctx.Done()
		return
	}

	client, err := d.buildClient()
	if err != nil {
		d.log.Error("could not build the upload client", logging.Any("error", err.Error()))
		<-ctx.Done()
		return
	}

	d.mu.Lock()
	d.client = client
	d.filter = privacy.New(toPrivacyConfig(d.monitoring), d.monitoring.Location())
	d.mu.Unlock()

	sup := supervisor.New(ctx, supervisor.Config{Logger: d.log})

	// The config poller runs even when capture is gated off, so an agent whose notice was declined
	// still learns about a policy change — and so a revocation is noticed rather than the device
	// continuing to look enrolled forever.
	sup.Go("config-poller", d.configPollLoop)
	sup.Go("heartbeat", d.heartbeatLoop)
	sup.Go("uploader", d.uploadLoop)
	sup.Go("housekeeping", d.housekeepingLoop)
	sup.Go("tray-refresh", d.trayRefreshLoop)

	if d.mayCapture {
		sup.Go("sampler", d.sampleLoop)
		sup.Go("screenshotter", d.screenshotLoop)
		d.recordEvent(ctx, store.Event{
			Type:       store.EventSessionStart,
			CapturedAt: time.Now(),
			Detail:     "agent " + d.version,
		})
	}

	if err := sup.Wait(); err != nil && !errors.Is(err, context.Canceled) {
		d.log.Error("a supervised loop stopped permanently", logging.Any("error", err.Error()))
	}

	// A clean stop is recorded, so a gap in a timesheet can be told apart from a crash.
	if d.mayCapture {
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		d.recordEvent(shutdown, store.Event{
			Type:       store.EventSessionEnd,
			CapturedAt: time.Now(),
		})
		// One last drain attempt, so a normal logout does not leave the day's tail unsent.
		d.drainOnce(shutdown)
	}
}

// toPrivacyConfig maps the server's monitoring policy onto the filter's configuration.
//
// A conversion rather than a shared type, because the filter must not depend on the wire format:
// its inputs are exactly the settings that can suppress data, and nothing else.
func toPrivacyConfig(m config.MonitoringConfig) privacy.Config {
	start, err := privacy.ParseTimeOfDay(m.WorkHoursStart)
	if err != nil {
		// An unparseable window means the policy cannot be honoured. 00:00 with WorkHoursOnly set
		// makes the window empty, so nothing is captured — the safe direction.
		start = 0
	}
	end, err := privacy.ParseTimeOfDay(m.WorkHoursEnd)
	if err != nil {
		end = 0
	}

	return privacy.Config{
		CaptureWindowTitles: m.CaptureWindowTitles,
		CaptureURLs:         m.CaptureURLs,
		WorkHoursOnly:       m.WorkHoursOnly,
		WorkHoursStart:      start,
		WorkHoursEnd:        end,
		WorkDays:            m.WorkDays,
		ExcludedApps:        m.ExcludedApps,
		ExcludedURLPatterns: m.ExcludedURLPatterns,
	}
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

func (d *daemon) sampleLoop(ctx context.Context) error {
	d.mu.RLock()
	monitoring := d.monitoring
	d.mu.RUnlock()

	sampler, err := capture.NewSampler(d.platform, time.Now, capture.Config{
		SampleInterval:      monitoring.SampleInterval(),
		IdleThreshold:       monitoring.IdleThreshold(),
		CaptureWindowTitles: monitoring.CaptureWindowTitles,
		CaptureURLs:         monitoring.CaptureURLs,
	})
	if err != nil {
		return fmt.Errorf("could not create the sampler: %w", err)
	}

	ticker := time.NewTicker(monitoring.SampleInterval())
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			// Flush the sample in progress so the last minute before a logout is not lost.
			if sample, ok := sampler.Flush(); ok {
				d.storeSample(context.Background(), sample)
			}
			return ctx.Err()

		case <-ticker.C:
			if d.isRevoked() {
				return nil
			}

			sample, emitted, err := sampler.Tick()
			if err != nil {
				if errors.Is(err, platform.ErrNoActiveWindow) {
					// A locked screen or a desktop switch. Normal, and not worth a log line every
					// minute while somebody is at lunch.
					continue
				}
				d.log.Warn("a sample could not be taken", logging.Any("error", err.Error()))
				continue
			}
			if emitted {
				d.storeSample(ctx, sample)
			}
		}
	}
}

// storeSample applies the privacy filter and buffers what survives.
//
// This is the only path from capture to disk. The filter runs here, before the write, so excluded
// data is never persisted at all — see internal/privacy.
func (d *daemon) storeSample(ctx context.Context, sample capture.Sample) {
	d.mu.RLock()
	filter := d.filter
	d.mu.RUnlock()

	if filter == nil {
		return
	}

	decision := filter.Decide(privacy.Sample{
		CapturedAt:  sample.CapturedAt,
		Duration:    sample.Duration,
		IsIdle:      sample.IsIdle,
		AppName:     sample.App.AppName,
		AppExe:      sample.App.AppExe,
		WindowTitle: sample.App.WindowTitle,
		URLHost:     sample.URLHost,
		URLTitle:    sample.URLTitle,
	})

	d.mu.Lock()
	d.lastReason = string(decision.Reason)
	d.mu.Unlock()

	if !decision.Allow {
		// Deliberately at debug and without the sample: a suppressed sample's content is precisely
		// what the exclusion existed to keep out of everything, including this log.
		d.log.Debug("sample suppressed",
			logging.Any("reason", string(decision.Reason)),
			logging.Any("rule", decision.Detail))
		return
	}

	filtered := decision.Sample
	eventType := store.EventWindowSample
	if filtered.IsIdle {
		eventType = store.EventIdleState
	}

	d.recordEvent(ctx, store.Event{
		Type:        eventType,
		CapturedAt:  filtered.CapturedAt,
		Duration:    filtered.Duration,
		IsIdle:      filtered.IsIdle,
		AppName:     filtered.AppName,
		AppExe:      filtered.AppExe,
		WindowTitle: filtered.WindowTitle,
		URLHost:     filtered.URLHost,
		URLTitle:    filtered.URLTitle,
	})
}

func (d *daemon) recordEvent(ctx context.Context, event store.Event) {
	if _, err := d.buffer.AppendEvent(ctx, event); err != nil {
		d.log.Warn("could not buffer an event",
			logging.Any("event_type", string(event.Type)), logging.Any("error", err.Error()))
	}
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

func (d *daemon) screenshotLoop(ctx context.Context) error {
	d.mu.RLock()
	interval := d.monitoring.ScreenshotInterval()
	d.mu.RUnlock()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if d.isRevoked() {
				return nil
			}
			d.captureScreenshot(ctx)
		}
	}
}

// captureScreenshot takes, filters, blurs and queues one image.
//
// The order matters: the work-hours and enabled checks happen BEFORE the capture, so no image of a
// screen outside working hours exists even momentarily in memory.
func (d *daemon) captureScreenshot(ctx context.Context) {
	d.mu.RLock()
	filter, monitoring := d.filter, d.monitoring
	d.mu.RUnlock()

	if filter == nil {
		return
	}

	if decision := filter.AllowScreenshot(time.Now(), monitoring.ScreenshotEnabled); !decision.Allow {
		d.log.Debug("screenshot suppressed", logging.Any("reason", string(decision.Reason)))
		return
	}

	image, err := screenshot.Capture()
	if err != nil {
		if errors.Is(err, screenshot.ErrNoDisplay) {
			// A locked laptop or an undocked machine. Expected, not an error worth reporting.
			return
		}
		d.log.Warn("could not capture the screen", logging.Any("error", err.Error()))
		return
	}

	if monitoring.ScreenshotBlur {
		image = screenshot.Blur(image, 12)
	}

	encoded, err := screenshot.EncodePNG(image)
	if err != nil {
		d.log.Warn("could not encode a screenshot", logging.Any("error", err.Error()))
		return
	}

	digest := sha256.Sum256(encoded)
	name := hex.EncodeToString(digest[:8]) + ".png"
	path := filepath.Join(d.paths.ScreenshotDir, name)

	// 0600: an image of somebody's screen must not be readable by another user of the machine.
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		d.log.Warn("could not write a screenshot", logging.Any("error", err.Error()))
		return
	}

	bounds := image.Bounds()
	if _, err := d.buffer.EnqueueScreenshot(ctx, store.Screenshot{
		CapturedAt: time.Now(),
		Path:       path,
		Width:      bounds.Dx(),
		Height:     bounds.Dy(),
		ByteCount:  int64(len(encoded)),
		SHA256:     hex.EncodeToString(digest[:]),
		Blurred:    monitoring.ScreenshotBlur,
	}); err != nil {
		d.log.Warn("could not queue a screenshot", logging.Any("error", err.Error()))
		// The row failed, so the file would never be uploaded or cleaned up. Remove it rather than
		// leaving an orphaned image of somebody's screen on disk forever.
		_ = os.Remove(path)
	}
}

// ---------------------------------------------------------------------------
// Uploading
// ---------------------------------------------------------------------------

func (d *daemon) uploadLoop(ctx context.Context) error {
	ticker := time.NewTicker(d.settings.UploadInterval())
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if d.isRevoked() {
				return nil
			}
			d.drainOnce(ctx)
		}
	}
}

// drainOnce uploads as much as the buffer holds, in batches.
func (d *daemon) drainOnce(ctx context.Context) {
	d.mu.RLock()
	client := d.client
	d.mu.RUnlock()
	if client == nil {
		return
	}

	// Bounded so one cycle cannot loop forever on a very large backlog and starve the other loops.
	const maxBatchesPerCycle = 20

	for i := 0; i < maxBatchesPerCycle; i++ {
		batch, err := d.buffer.ClaimBatch(ctx, d.settings.MaxBatchEvents)
		if err != nil {
			d.log.Warn("could not claim a batch", logging.Any("error", err.Error()))
			return
		}
		if batch.Empty() {
			return
		}

		result, err := client.UploadEvents(ctx, batch.Events)
		if err != nil {
			d.handleUploadError(ctx, batch.ClaimID, err)
			return
		}

		if _, err := d.buffer.DeleteBatch(ctx, batch.ClaimID); err != nil {
			// The server has the events; failing to delete locally means they are resent, which is
			// free thanks to the idempotency key.
			d.log.Warn("uploaded a batch but could not clear it locally",
				logging.Any("error", err.Error()))
		}

		d.mu.Lock()
		d.lastUploadAt = time.Now()
		d.mu.Unlock()
		_ = d.buffer.SetMeta(ctx, store.MetaLastUploadAt, time.Now().UTC().Format(time.RFC3339))

		d.log.Info("uploaded a batch",
			logging.Any("accepted", result.Accepted),
			logging.Any("duplicates", result.Duplicates),
			logging.Any("already_processed", result.Duplicate))
	}
}

// handleUploadError releases the batch and reacts to the specific failure.
func (d *daemon) handleUploadError(ctx context.Context, claimID string, err error) {
	// Released unconditionally: whatever went wrong, these events must become claimable again or
	// they are stranded until the stale-claim sweep.
	if _, releaseErr := d.buffer.ReleaseBatch(ctx, claimID); releaseErr != nil {
		d.log.Error("could not release a failed batch; it will be recovered by the stale-claim sweep",
			logging.Any("error", releaseErr.Error()))
	}

	var apiErr *uploader.APIError
	if errors.As(err, &apiErr) {
		switch {
		case apiErr.Revoked():
			// Terminal. Capture stops and the tray says so, rather than the agent retrying a
			// credential that will never work again.
			d.log.Error("this device has been revoked; capture is stopping")
			d.mu.Lock()
			d.revoked = true
			d.mayCapture = false
			d.mu.Unlock()
			return
		case apiErr.ClockSkew():
			d.log.Error("the server rejected this device's clock; uploads will fail until it is corrected",
				logging.Any("hint", "check the Windows time service"))
			return
		}
	}

	d.log.Warn("upload failed; the batch stays buffered", logging.Any("error", err.Error()))
}

// ---------------------------------------------------------------------------
// Configuration, heartbeat, housekeeping
// ---------------------------------------------------------------------------

func (d *daemon) configPollLoop(ctx context.Context) error {
	// Fetched immediately as well as on the tick, so a policy change made minutes before a laptop
	// boots is honoured from the first sample rather than fifteen minutes in.
	d.pollConfig(ctx)

	ticker := time.NewTicker(d.settings.ConfigPollInterval())
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if d.isRevoked() {
				return nil
			}
			d.pollConfig(ctx)
		}
	}
}

func (d *daemon) pollConfig(ctx context.Context) {
	d.mu.RLock()
	client := d.client
	current := d.monitoring.ConfigVersion
	d.mu.RUnlock()
	if client == nil {
		return
	}

	raw, err := client.FetchConfig(ctx)
	if err != nil {
		var apiErr *uploader.APIError
		if errors.As(err, &apiErr) && apiErr.Revoked() {
			d.log.Error("this device has been revoked; capture is stopping")
			d.mu.Lock()
			d.revoked = true
			d.mayCapture = false
			d.mu.Unlock()
			return
		}
		d.log.Warn("could not fetch the monitoring configuration; continuing with the cached one",
			logging.Any("error", err.Error()))
		return
	}

	fetched, err := config.UnmarshalMonitoringConfig(string(raw))
	if err != nil {
		d.log.Warn("the monitoring configuration was unreadable; keeping the cached one",
			logging.Any("error", err.Error()))
		return
	}
	if err := fetched.Validate(); err != nil {
		// Refused rather than applied. The server validates on write, so this means a bug or a
		// tampered response, and acting on it could widen what is collected.
		d.log.Error("the monitoring configuration is invalid; keeping the cached one",
			logging.Any("error", err.Error()))
		return
	}

	if fetched.ConfigVersion == current {
		return
	}

	encoded, err := fetched.Marshal()
	if err == nil {
		_ = d.buffer.SetMeta(ctx, store.MetaConfigJSON, encoded)
		_ = d.buffer.SetMeta(ctx, store.MetaConfigVersion, config.FormatVersion(fetched.ConfigVersion))
	}

	d.mu.Lock()
	d.monitoring = fetched
	d.filter = privacy.New(toPrivacyConfig(fetched), fetched.Location())
	d.mu.Unlock()

	// The sampler and screenshotter read their intervals once at start, so an interval change needs
	// a restart to take effect. Said plainly rather than silently ignored — a deployer who shortens
	// the interval and sees nothing change deserves to know why.
	d.log.Info("monitoring configuration updated",
		logging.Any("from_version", current),
		logging.Any("to_version", fetched.ConfigVersion),
		logging.Any("note", "exclusions and work hours apply immediately; "+
			"changed sample or screenshot intervals take effect at the next agent restart"))
}

func (d *daemon) heartbeatLoop(ctx context.Context) error {
	ticker := time.NewTicker(d.settings.HeartbeatInterval())
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if d.isRevoked() {
				return nil
			}

			d.mu.RLock()
			client, version := d.client, d.monitoring.ConfigVersion
			dropped := d.droppedTotal
			d.mu.RUnlock()
			if client == nil {
				continue
			}

			stats, err := d.buffer.Stats(ctx)
			if err != nil {
				d.log.Warn("could not read buffer statistics", logging.Any("error", err.Error()))
				continue
			}

			if err := client.Heartbeat(ctx, uploader.HeartbeatRequest{
				AgentVersion:   d.version,
				BufferedEvents: stats.Events,
				BufferedBytes:  stats.EstimatedBytes,
				DroppedEvents:  dropped,
				ConfigVersion:  version,
			}); err != nil {
				d.log.Debug("heartbeat failed", logging.Any("error", err.Error()))
			}
		}
	}
}

// housekeepingLoop enforces the buffer cap and records what it dropped.
func (d *daemon) housekeepingLoop(ctx context.Context) error {
	// Hourly: the cap is a backstop for a long offline period, not something that needs checking
	// every minute.
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			byAge, byCap, err := d.buffer.EnforceCap(ctx)
			if err != nil {
				d.log.Warn("the buffer cap sweep failed", logging.Any("error", err.Error()))
				continue
			}

			total := byAge + byCap
			if total == 0 {
				continue
			}

			d.mu.Lock()
			d.droppedTotal += total
			d.mu.Unlock()

			d.log.Warn("dropped buffered events to stay within limits",
				logging.Any("aged_out", byAge), logging.Any("over_cap", byCap))

			// Recorded as an event so the gap has an explanation on the server too. A timesheet
			// with an unexplained hole is indistinguishable from one where the employee did
			// nothing.
			d.recordEvent(ctx, store.Event{
				Type:       store.EventAgentHealth,
				CapturedAt: time.Now(),
				Detail: fmt.Sprintf("dropped %d buffered events (%d aged out, %d over the size cap)",
					total, byAge, byCap),
			})

			// The file does not shrink on its own, so a buffer that spiked to its cap would stay
			// that size on disk forever.
			if byCap > 0 {
				if err := d.buffer.Vacuum(ctx); err != nil {
					d.log.Warn("could not reclaim buffer space", logging.Any("error", err.Error()))
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

func (d *daemon) trayRefreshLoop(ctx context.Context) error {
	// Frequent enough that the buffered count is not visibly stale, cheap enough not to matter.
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			d.publishState(ctx)
		}
	}
}

// publishState pushes the current state to the tray.
func (d *daemon) publishState(ctx context.Context) {
	if d.tray == nil {
		return
	}

	d.mu.RLock()
	reason, lastUpload, revoked, mayCapture := d.lastReason, d.lastUploadAt, d.revoked, d.mayCapture
	d.mu.RUnlock()

	state := tray.State{
		AgentVersion: d.version,
		LastUploadAt: lastUpload,
		Detail:       reason,
	}

	if stats, err := d.buffer.Stats(ctx); err == nil {
		state.BufferedEvents = stats.Events
		state.OldestBufferedAt = stats.OldestCapturedAt
	}

	switch {
	case revoked:
		state.Status = tray.StatusRevoked
	case !d.enrolled:
		state.Status = tray.StatusNotEnrolled
	case !mayCapture:
		state.Status = tray.StatusAwaitingNotice
	case reason != "" && reason != string(privacy.ReasonAllowed):
		state.Status = tray.StatusPaused
	case state.BufferedEvents > int64(d.settings.MaxBatchEvents)*2:
		// A backlog well past one batch means uploads are not keeping up, which the employee should
		// see rather than being shown a confident "monitoring is active".
		state.Status = tray.StatusOffline
	default:
		state.Status = tray.StatusMonitoring
	}

	d.tray.SetState(state)
}

// trayCallbacks wires the menu items.
func (d *daemon) trayCallbacks() tray.Callbacks {
	callbacks := tray.Callbacks{
		OnShowNotice: func() {
			// Re-shown on demand and NOT re-recorded: this is the employee reading the disclosure
			// again, not acknowledging it a second time.
			presenter, err := notice.NewPresenter()
			if err != nil {
				d.log.Warn("could not show the notice", logging.Any("error", err.Error()))
				return
			}
			if _, err := presenter.Present(notice.Text(d.noticeDetails())); err != nil {
				d.log.Warn("could not show the notice", logging.Any("error", err.Error()))
			}
		},
		OnQuit: func() {
			d.log.Info("stopping at the employee's request from the tray menu")
		},
	}

	if d.settings.DashboardURL != "" {
		callbacks.OnOpenDashboard = func() {
			if err := openInBrowser(d.settings.DashboardURL); err != nil {
				d.log.Warn("could not open the dashboard", logging.Any("error", err.Error()))
			}
		}
	}

	return callbacks
}

// openInBrowser opens a URL in the employee's default browser.
func openInBrowser(target string) error {
	switch runtime.GOOS {
	case "windows":
		// rundll32 rather than `cmd /c start`: start would interpret an ampersand in the URL as a
		// shell operator, and building a command line for cmd is how URL-handling bugs become
		// command injection.
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", target).Start()
	case "darwin":
		return exec.Command("open", target).Start()
	default:
		return exec.Command("xdg-open", target).Start()
	}
}

func (d *daemon) isRevoked() bool {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.revoked
}
