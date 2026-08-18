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

Nothing released yet. The initial scaffolding, plan, and repository
infrastructure are in place; see `docs/PLAN.md` for the phase breakdown and
`README.md` for what WorkLens is.

## [0.1.0] - Unreleased

The first tagged release, cut at the end of Phase 7. This entry is completed at
release with the shipped contents; the outline below is the scope it covers.

- **Agent** — a visible Go agent for Windows: first-run notice and tray icon,
  active-application and window-title sampling, idle detection from last-input
  timing, optional blurred screenshots, local SQLite buffering that survives
  being offline, HMAC-signed batched upload with retry and backoff and TLS
  certificate pinning, and `worklens-agentctl` for enrolment, installation and
  diagnostics.
- **Backend** — device enrolment and per-device authentication, idempotent
  batched event ingestion, presigned KMS-encrypted screenshot uploads, nightly
  and on-demand timesheet aggregation, reporting APIs, monitoring
  configuration, retention sweeping and a working hard-delete path, and an
  audit log of every access to employee data.
- **Dashboard** — Cognito authentication with owner, manager and employee
  roles, team overview, per-employee day and week timesheets, screenshot
  gallery, CSV and PDF payroll export, an employee self-view, administrative
  settings and an audit-log view.
- **Infrastructure** — the entire AWS backend as Terraform, brought up with one
  `terraform apply`.
- **Privacy** — no keystroke content, password, clipboard, webcam or microphone
  capture, enforced by a CI gate rather than by convention; least-invasive
  defaults with screenshots and URL capture off; exclusion, work-hours and blur
  rules applied on the device before anything is buffered.

[Unreleased]: https://github.com/worklens/worklens/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/worklens/worklens/releases/tag/v0.1.0
