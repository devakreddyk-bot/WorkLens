# WorkLens agent

The Windows program that runs on a monitored laptop. Go 1.23, no cgo, one static
executable per command.

**Read [`docs/AGENT.md`](../docs/AGENT.md) first** — it covers what is collected, what
cannot be collected, why this is a scheduled task rather than a service, and where the
limits are. This file is only the map of the source tree.

## Layout

```
cmd/worklens-agent/       the daemon: startup ordering, then the supervised loops
cmd/worklens-agentctl/    enrol, install, status, doctor, notice
internal/signing/         HMAC request signing; pinned by contracts/signature-vectors.json
internal/privacy/         what may be recorded — the most important package here
internal/store/           the local SQLite buffer and the claim protocol
internal/uploader/        HTTP client, retries, certificate pinning
internal/config/          settings, credentials, the cached monitoring policy
internal/capture/         the sampler and browser-title URL derivation
internal/platform/        the Win32 layer, behind an interface with a darwin stub
internal/screenshot/      capture, blur, PNG encoding
internal/notice/          the first-run transparency notice and its gate
internal/tray/            the visible indicator
internal/logging/         structured logging with mandatory redaction
internal/supervisor/      restarts panicking loops with bounded backoff
```

## Build and test

```bash
make agent-windows                  # from the repository root, into bin/
go test ./... -race                 # everything runs on macOS and Linux
GOOS=windows GOARCH=amd64 go vet ./...   # covers the syscall layer
```

`CGO_ENABLED=0` is required, which is why the SQLite driver is `modernc.org/sqlite`.
See `docs/AGENT.md` §9.

## Before changing anything here

- `scripts/check-privacy.sh` fails the build on any reference to a forbidden capture API,
  including in test fixtures. That is deliberate and it has fired twice.
- The signing format is pinned by `contracts/signature-vectors.json` and tested from both
  Go and TypeScript. Changing it is a protocol change that stops every deployed agent
  authenticating.
- Idle events carry no attribution, enforced in four places. Do not remove one because the
  other three exist.
- The tray is mandatory on Windows. An agent that cannot show itself must not run.
