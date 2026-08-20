# Changelog

All notable changes to WorkLens are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries are written for the people who deploy and operate WorkLens, not for the
people who wrote it: say what changed for them and what they must do about it.
Anything that alters **what data is collected**, or what a deployer must tell
their employees, belongs under its own bold **Privacy** note in the relevant
section — that is the entry a deployer will look for first.

<!-- Add your entry to [Unreleased] in the same pull request as the change.
     Sections, in this order, omitting any that are empty:
       Added       — new capabilities
       Changed     — changes to existing behaviour
       Deprecated  — soon-to-be-removed capabilities
       Removed     — capabilities removed in this release
       Fixed       — bug fixes
       Security    — vulnerability fixes and hardening
     Link the pull request or issue number on each entry. -->

## [Unreleased]

Nothing yet.

## [0.1.0] - 2026-08-20

The first release. Everything below is implemented and tested; §"Not in this
release" is what a reader might reasonably expect and will not find.

### Added

- **Agent** — a visible Go agent for Windows: a first-run notice the employee
  acknowledges before anything is collected, a tray icon for as long as it runs,
  active-application and window-title sampling, idle detection from last-input
  timing, optional blurred screenshots, local SQLite buffering that survives
  being offline, HMAC-signed batched upload with retry and backoff, TLS
  certificate pinning to Amazon's root CAs, and `worklens-agentctl` for
  enrolment, installation and diagnostics. Installed as a **logon Scheduled
  Task**, not a Windows service — a session-0 service cannot see the
  interactive desktop, so it could not show the tray icon that makes the agent
  visible.
- **Backend** — device enrolment with derived, never-stored device secrets;
  idempotent batched event ingestion; presigned KMS-encrypted screenshot
  uploads; nightly timesheet aggregation as a pure function; reporting and
  administration APIs; per-organisation monitoring configuration; retention
  sweeping and a working two-step hard-delete path; and an audit log of every
  access to employee data, append-only by database grant rather than by
  convention.
- **Dashboard** — Cognito authentication with owner, manager and employee
  roles; a team overview; per-employee day and week timesheets; a screenshot
  gallery whose URLs are issued per image on click, so an unopened image is not
  recorded as viewed; CSV payroll export; an employee self-view built from the
  same components as the manager's view; administrative settings; and an
  audit-log view.
- **Infrastructure** — the entire AWS backend as Terraform: 10 modules plus a
  remote-state bootstrap, no NAT gateway, RDS in private subnets with IAM
  authentication.
- **Documentation** — architecture, agent behaviour, API reference, deployment
  runbook, configuration reference, operations runbook, security implementation
  record, and a responsible-use document covering the deployer's legal
  obligations.

### Security

- **Privacy** — no keystroke content, password, clipboard, webcam or microphone
  capture. Enforced by a CI gate (`scripts/check-privacy.sh`) rather than by
  convention, and by CHECK constraints in the schema: an idle event may not
  carry attribution, and screenshots may not outlive the events they belong to.
  Least-invasive defaults, with screenshots and URL capture **off**; exclusion,
  work-hours and blur rules applied on the device before anything is buffered,
  so excluded data is never stored and therefore can never be uploaded.
- **Removed an unauthorised route before release.** `POST /aggregation/run` was
  authenticated but not authorised: it was wired straight at the aggregation job
  Lambda, which reads no Cognito claim, so any signed-in user of any role could
  trigger a cross-organisation aggregation run. It also could not work — the
  function takes a job event, not a proxy event. No data was disclosed. See
  `docs/SECURITY.md` §2.3.1.
- **Six CI gates** guard the properties that reviews miss: forbidden capture
  APIs, unjustified IAM wildcards, the README's responsible-use section, the two
  hand-maintained Lambda lists agreeing, every migration being bundled, and the
  three hand-maintained route lists agreeing in both directions.

### Not in this release

Stated plainly, because each is something a reader might reasonably expect:

- **PDF export.** The API rejects `format=pdf` with a message saying where it
  would be rendered. Nothing implements it.
- **On-demand aggregation as an API call.** Re-running aggregation is an
  operator action against the function directly. A synchronous HTTP trigger is
  the wrong shape — the integration timeout is 29 seconds and a run is not
  bounded by it — so the real feature would need to be asynchronous.
- **A rule-preview endpoint.** An owner cannot see what a project rule would
  match before saving it.
- **`text/csv` responses.** The CSV arrives base64-encoded inside a JSON
  envelope, because the shared response wrapper serialises every body with
  `JSON.stringify`. The bytes are exact; the envelope is a wart.

### Unverified

- **Nothing has been deployed to AWS.** `terraform validate` passes, the schema
  is verified against a live PostgreSQL 16, and the tests pass across all three
  components — 427 in the backend, 260 in the agent across 13 packages under
  `-race`, and 102 in the dashboard — but no AWS account has ever run this. IAM has not been
  exercised, the WAF has not seen traffic, and the presigned-upload path has not
  been tested end to end against real S3.
- **The Windows agent has not run on Windows.** It cross-compiles, `go vet`
  passes for `windows/amd64`, and every package with testable logic is tested —
  but the Win32 syscall layer has never executed.
- **CI has never run on GitHub.** Every job has been reproduced locally against
  a clean checkout, including under the Go version CI pins, but the workflow
  itself has not executed on a runner.
- **No penetration test or external review.**

[Unreleased]: https://github.com/worklens/worklens/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/worklens/worklens/releases/tag/v0.1.0
