# The agent

The Windows program that runs on a monitored laptop. This document is the reference for
what it collects, what it cannot collect, why it is built the way it is, and where its
limits are.

If you are looking for what an *employee* is told, that is `worklens-agentctl notice` —
the same text the agent shows on first run, rendered from this installation's actual
configuration.

---

## 1. What it collects

Per sample, at the configured interval (60 s by default):

| Field | Source | Governed by |
|---|---|---|
| Active application name and executable path | `GetForegroundWindow` → `GetWindowThreadProcessId` → `QueryFullProcessImageNameW` | always collected when capture is on |
| Window title | `GetWindowTextW` | `capture_window_titles` |
| Site host and page title | derived from the browser's window title — see §5 | `capture_urls` (and requires titles) |
| Active vs idle | `GetLastInputInfo` | `idle_threshold_seconds` |
| Screenshot | `kbinani/screenshot`, optionally blurred | `screenshot_enabled`, `screenshot_blur` |

Consecutive identical samples are coalesced into one event with a summed duration, which
reduces event volume by roughly 10–20× on typical usage.

### What it cannot collect

Not "does not" — **cannot**, in the sense that the mechanism is absent:

- **Keystroke content.** The agent installs no keyboard hook. It never calls
  `SetWindowsHookEx`, `GetAsyncKeyState`, `GetKeyboardState`, or
  `RegisterRawInputDevices`. The only thing it asks the operating system about typing is
  `GetLastInputInfo`, which returns a single tick count — how long ago the last input
  event happened, with no key in it.
- **Passwords.** Follows from the above.
- **Clipboard contents.** `OpenClipboard` and `GetClipboardData` are never called.
- **Camera or microphone.** No such dependency is linked.
- **File, email or message contents.** The agent records that an application was in use,
  never what was inside it.

`scripts/check-privacy.sh` fails the build if any of those API names appears in a source
file, including in a test fixture. It has caught exactly that twice during development.

### Idle time carries no attribution

When a sample is idle, the application, window title and host are **not recorded at all**.
This is enforced in four places, deliberately:

1. The sampler does not ask the OS which window has focus on an idle tick.
2. `internal/privacy` strips attribution from any idle sample that reaches it.
3. `internal/store` refuses to buffer an idle event carrying attribution.
4. The server's `activity_events_idle_no_attribution_chk` rejects the batch.

The guarantee to an employee is that idle minutes cannot be used to infer what was on
screen. Four layers is not redundancy for its own sake — each one fails differently, and
the database is the only one an application bug cannot route around.

---

## 2. Why it is not a Windows service

**A service cannot do this job.** This is deviation D5 in `docs/PLAN.md`, and it is the
single most important structural fact about the agent.

Windows services run in **session 0**, isolated from interactive desktops since Vista.
From there:

- `GetForegroundWindow` returns the session-0 desktop's foreground window — nothing a user
  is looking at.
- `GetLastInputInfo` reports session-0 input, of which there is never any.
- A screen capture returns a blank or black frame.

A service-based agent would install cleanly, run without error, and **report every
employee as permanently idle**. It would look like it worked.

So the agent runs as a **per-user scheduled task with a logon trigger**, in the employee's
own session, at their own integrity level. `worklens-agentctl install` registers it; see
`worklens-agentctl install --print` for the exact definition.

That arrangement is also the more transparent one, which the product wants: a process the
employee owns, with a tray icon they can see and a Task Manager entry they can end — rather
than a SYSTEM service they can neither see nor stop. The tray menu includes **Quit** for
the same reason: they can already stop it, and a menu item makes that honest rather than
something they have to discover.

### What the task definition sets, and why

| Setting | Value | Reason |
|---|---|---|
| `LogonTrigger` + `InteractiveToken` | — | The only way to observe the desktop at all. |
| `RunLevel` | `LeastPrivilege` | The agent needs no elevation, and asking for it would make an employee's own machine something they control less. |
| `Hidden` | `false` | A hidden scheduled task is how covert monitoring software installs itself. |
| `StopIfGoingOnBatteries` | `false` | A laptop on battery is exactly when somebody is working. |
| `ExecutionTimeLimit` | `PT0S` | The default is 72 hours, after which Windows would kill the agent and the employee would silently stop being recorded. |
| `MultipleInstancesPolicy` | `IgnoreNew` | Two agents would double every event, and the server could not deduplicate them — the client event ids differ, so both copies look legitimate. |
| `RestartOnFailure` | 3 × 1 min | Crash recovery, bounded. A permanently crashing agent should stop rather than spin, and the absent tray icon then becomes the visible signal. |

---

## 3. Startup order is a privacy control

`cmd/worklens-agent/main.go` runs these in order, and the order is load-bearing:

```
1. settings + paths          failures get reported to a real log
2. local buffer + recovery   release claims a previous crash left behind
3. credentials               absent → tray says "not set up", nothing is captured
4. THE NOTICE GATE           no capture goroutine exists until this passes
5. THE TRAY                  cannot be created → exit non-zero
6. capture / upload / housekeeping loops
```

**Steps 4 and 5 are the ones a well-meaning change would break.**

Step 4 is not "start capturing and filter afterwards". An agent that captured first would
have already read the screen of somebody who had not been told. `notice.Outcome`'s zero
value is `OutcomeNotAcknowledged` and its `MayCapture()` is false, so a caller that ignores
an error, or a future early return, cannot accidentally produce an outcome that permits
capture.

Step 5 exits the process. An agent with no visible indicator is covert monitoring software,
which is the one thing this product must never be. Off Windows it warns and continues
headless, because that is what a developer smoke test needs — and that distinction is made
in exactly one place, in `main.go`, guarded by `runtime.GOOS`.

---

## 4. Offline behaviour

Everything captured goes to a local SQLite buffer first and is deleted only once the server
has acknowledged it. That is what carries the agent through a train tunnel, a hotel captive
portal, a laptop closed mid-upload, and a backend deploy.

### The claim protocol

Uploading is not read-send-delete. A crash between send and delete would resend everything;
a crash between read and send would block forever behind rows nobody owns. Instead:

```
AppendEvent   → claimed_by IS NULL
ClaimBatch    → claimed_by = <id>, claimed_at = now
DeleteBatch   → rows gone, after a 2xx
ReleaseBatch  → claimed_by = NULL, after a retryable failure
Recover       → releases claims older than 15 minutes, at startup
```

Duplicate *prevention* is deliberately not this protocol's job — the server deduplicates on
`(device_id, client_event_id)`, which is the only place it can be enforced. The protocol
exists to stop rows being **lost** or **stuck**.

### Retries

Exponential backoff with full jitter, five attempts, then the batch returns to the buffer
and the next cycle tries again. The jitter is not decoration: an office's agents all come
back at the same moment after a wifi outage, and identical backoff would have them retry in
lockstep, repeatedly.

A fresh nonce is generated for **every attempt** — reusing it would make the retry look like
a replay to the server. The `Idempotency-Key`, by contrast, stays **stable** across attempts,
derived from the sorted client event ids, so the server recognises the retry as the same
batch.

Retry classification is deliberate about one case: a `401` is normally permanent, but
`TIMESTAMP_OUT_OF_WINDOW` is retried, because NTP may correct the clock between attempts.
A revoked device is terminal. A pin mismatch is never retried.

### The cap

Default 250 MB or 14 days, whichever comes first. Over the cap, the **oldest** events are
dropped — recent activity is most of what a timesheet is about — and an `agent_health` event
records how many, so a gap in a timesheet is always explainable rather than mysterious. The
sweep never touches claimed rows.

---

## 5. URL capture, and its limits

This is deviation D9, and the limits matter more than the feature.

**What it does.** When the active application is a known browser, the agent parses the
window title. Browser titles look like:

```
Quarterly report — Google Chrome
docs.aws.amazon.com — Google Chrome
Inbox (12) and 3 more pages - Personal - Microsoft​ Edge
Privacy Notice — Mozilla — Mozilla Firefox
```

It strips the browser suffix to get a page title, and *sometimes* recovers a host when the
title happens to contain a domain.

**What it does not do, and cannot:**

- **There is no full URL.** No path, no query string, no fragment. A window title does not
  contain them.
- **A host is often unavailable.** `Quarterly report — Google Chrome` names no site. The
  agent returns nothing rather than guessing.
- **It refuses to guess three ways.** A conservative TLD allowlist (deliberately excluding
  `.md`, `.rs`, `.ts`, `.sh`, `.zip`, `.pl`, `.so` — a code host's tab titles are full of
  them); two disagreeing candidates in one title yield nothing; anything containing `@` is
  skipped, because it is an email address rather than a host.
- **Only recognised browsers.** Identified by executable name, never guessed from the title.
  `code.exe` with a title mentioning a domain yields nothing.

**Why not a browser extension.** An extension would give true URLs. It is deliberately not
built, because it widens what is collected — and the narrower source is the correct one for
this product. If a deployment genuinely needs full URLs, that is a product decision with a
privacy consequence, not a missing feature.

**One implementation note.** Some Microsoft Edge builds insert a zero-width space (U+200B)
into `Microsoft​ Edge`. The suffix stripper handles it; without that, every Edge page title
would keep its browser suffix.

---

## 6. Screenshots

Off by default. When enabled:

1. The work-hours and enabled checks run **before** the capture, so no image of a screen
   outside working hours exists even momentarily in memory.
2. Blur is applied on the device if configured, before anything is written.
3. The PNG is written to the queue directory at mode `0600` and a row is queued.
4. The agent requests a constrained presigned S3 URL and PUTs the bytes directly. Image
   data never passes through the backend.

**Blur is a privacy control, so it is tested as one.** A high-contrast checkerboard's pixel
variance drops from 16256 to 2.4 — 0.015 % retained. That test exists because a blur that
silently no-ops would ship sensitive pixels while everything looked fine.

If the queue row fails to insert, the file is deleted. Otherwise an orphaned image of
somebody's screen would sit on disk with nothing that would ever upload or remove it.

---

## 7. Security

**Transport.** TLS 1.2 minimum. Every request is signed with HMAC-SHA256 over
`METHOD \n PATH \n TIMESTAMP \n NONCE \n hex(sha256(BODY))` — see
`contracts/signature-vectors.json`, which pins the agreement with the server's verifier and
is tested from both languages.

**Certificate pinning** (deviation D8) pins the SPKI of a certificate **authority**, not the
leaf. A leaf pin would fail fleet-wide, simultaneously, on whichever day ACM rotated — and
would look like a backend outage rather than an expiry. All four Amazon roots are pinned,
including the ECDSA ones the endpoint does not use today, so a certificate-type change
cannot take the fleet offline.

Pinning is **additional**, never a replacement: `InsecureSkipVerify` is never set, so the
system's own chain and hostname verification runs first.

To disable it — the only legitimate reason is a mandatory corporate TLS-inspection proxy:

```
WORKLENS_TLS_PINNING=off
```

The agent logs a warning on **every** startup when this is set. A silent downgrade would be
worse than no pinning, because nobody would know.

**The device secret** lives only in `credentials.json`, mode `0600`, in the user's own
profile. It is registered with the logger's redactor at startup, so it cannot reach a log
even through a field nobody anticipated. `Credentials.String()` omits it, so a credential
passed to a `%v` cannot print it.

The server derives the secret from a root key and does not store it, so losing the file
means re-enrolling and leaking it means someone can submit activity as this device until it
is revoked.

---

## 8. Operating it

```bash
# Enrol (token from the dashboard: Settings > Devices)
worklens-agentctl enroll --token wlen_... --api-url https://<api>/v1

# Start at logon
worklens-agentctl install

# Start now, without signing out
schtasks /Run /TN "WorkLens Agent"

# What is configured, and is the buffer keeping up
worklens-agentctl status

# Diagnose everything that commonly goes wrong
worklens-agentctl doctor

# Preview exactly what employees on this machine will be shown
worklens-agentctl notice

# Stop capturing and remove local data
worklens-agentctl unenroll
worklens-agentctl uninstall
```

### `doctor` is the first thing to run

The agent is deliberately quiet: it captures nothing when unenrolled, nothing before the
notice is acknowledged, and nothing outside working hours. All three are correct, and all
three are indistinguishable from "broken" to whoever deployed it. `doctor` checks each of
them and reports **what to do**, not only what is wrong. It exits non-zero on any failure,
so a deployment script can gate on it.

It performs a real TLS handshake with the configured pins, because the failure it most often
catches is a pin mismatch behind an interception proxy — which only surfaces when the
certificate is actually verified. It also compares the local clock against the server's
`Date` header: a laptop 47 minutes fast otherwise presents as an unexplained `401`.

### Files

| Path | Contents |
|---|---|
| `%LOCALAPPDATA%\WorkLens\config.json` | Machine settings. No secret. |
| `%LOCALAPPDATA%\WorkLens\credentials.json` | Device id and secret, mode `0600`. |
| `%LOCALAPPDATA%\WorkLens\buffer.db` | Unsent events, screenshot queue, cached policy. |
| `%LOCALAPPDATA%\WorkLens\queue\*.png` | Screenshots awaiting upload. |
| `%LOCALAPPDATA%\WorkLens\worklens-agent.log` | Rotating log. Titles are redacted. |

`LOCALAPPDATA`, not `APPDATA`: a roaming profile would sync a SQLite database between
machines and corrupt it. Per-user rather than machine-wide because the buffer contains *that
user's* window titles, and another user of the same machine has no business reading them.

---

## 9. Building

```bash
make agent-windows     # cross-compiles both binaries into bin/
cd agent && go test ./... -race
```

`CGO_ENABLED=0` is not optional. It is what allows a single static `.exe` to be built from a
Mac or a Linux CI runner, and it is why the SQLite driver is `modernc.org/sqlite` (pure Go)
rather than `mattn/go-sqlite3` (cgo). Changing the driver would put a Windows C toolchain in
the build path and break cross-compilation entirely.

The module floor is `go 1.23`. A dependency whose own `go` directive is higher silently
raises it, so pin versions accordingly — `golang.org/x/sys` is held at `v0.30.0` for exactly
this reason.

### Testing on macOS

All logic is testable off Windows. `internal/platform` has a `darwin` implementation that
returns `ErrUnsupported`, and the Win32 code is behind a build tag, so:

- `go test ./...` exercises the sampler, the URL derivation, the privacy filter, the buffer,
  the signing contract, the pinning, the retry logic and the tray formatting.
- `GOOS=windows go build ./...` and `GOOS=windows go vet ./...` cover the syscall layer.

`internal/platform/windows` has no tests, because it is pure syscall and unrunnable here.
Its correctness rests on cross-compilation, `GOOS=windows go vet`, and the fact that the
logic worth testing — error mapping, base-name splitting — sits above it in
`platform_windows.go`.

---

## 10. Known limits

Stated rather than buried:

- **Windows only.** The `platform` interface has a `darwin` seam, but no macOS
  implementation. It returns `ErrUnsupported`; the agent logs it and captures nothing.
- **No full URLs.** See §5.
- **A changed sample or screenshot interval needs a restart.** Exclusions, work hours and
  the capture toggles apply on the next config poll; the two intervals are read once when
  the loops start. The agent logs this when it applies a config change, so a deployer who
  shortens the interval and sees nothing happen is told why.
- **Screenshot capture is not unit-tested against a real display.** The four failure paths
  are tested with fakes; the `kbinani` call itself is one line, because exercising it on
  macOS would depend on a Screen Recording permission prompt.
- **`GetLastInputInfo` is session-wide.** It reports the last input anywhere in the user's
  session, not per-application. That is the correct granularity for active-vs-idle and is
  the only granularity available without an input hook, which the product forbids.
- **A locked screen reports no foreground window.** Treated as `ErrNoActiveWindow` and
  skipped silently rather than logged every minute while somebody is at lunch.
