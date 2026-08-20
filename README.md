# WorkLens

[![CI](https://github.com/worklens/worklens/actions/workflows/ci.yml/badge.svg)](https://github.com/worklens/worklens/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Go 1.23](https://img.shields.io/badge/go-1.23-00ADD8.svg)](https://go.dev/dl/)
[![Node 22](https://img.shields.io/badge/node-22-339933.svg)](https://nodejs.org/en/download)
[![Terraform 1.9](https://img.shields.io/badge/terraform-1.9-7B42BC.svg)](https://developer.hashicorp.com/terraform/downloads)

WorkLens is a transparent employee time-tracking and activity-monitoring system for a single
company. A visible Go agent on company-issued Windows laptops samples which application is in
focus and whether the machine is being used, buffers that locally in SQLite so it survives being
offline, and ships it to an AWS backend over signed HTTPS. A scheduled job rolls the raw samples
into per-employee daily timesheets, and a Next.js dashboard lets an owner review and export them
for payroll — while letting every employee see exactly the same data about themselves. What
distinguishes it is not the feature list but the posture: no content capture of any kind,
least-invasive defaults, an agent the employee can see and stop, and privacy rules enforced on the
laptop before anything is uploaded.

---

## Responsible & Lawful Use

**Read this section before you deploy WorkLens. It is not boilerplate.**

WorkLens is a **transparent workplace productivity tool**, intended for company-issued devices,
with the employee's knowledge, for the purpose of producing defensible timesheets. It is not
surveillance software, and it is deliberately built so that it cannot be repurposed as such.

### What WorkLens does not collect — ever

These are hard constraints of the design, not configuration options. There is no setting, flag or
environment variable that turns any of them on.

- **No keystroke content.** WorkLens never records which keys were pressed or what was typed. It
  does not install a keyboard hook and does not read raw input. Idle detection uses the Windows
  `GetLastInputInfo` call, which returns only a *timestamp* of the most recent input event — the
  operating system hands over no key data at all. Consequently WorkLens cannot capture a
  **password**, a PIN, a private message or anything else that is typed.
- **No webcam.** No camera device is opened and no camera library is linked into the agent.
- **No microphone.** No audio capture interface is opened and no audio library is linked.
- **No clipboard content.** The clipboard is never read.
- **No personal-device monitoring.** WorkLens is designed for company-issued hardware only.

A build-time check, `scripts/check-privacy.sh`, fails continuous integration if any source file so
much as references the APIs that would make the above possible, and the database schema has no
column that could hold captured content. The guarantees are enforced by the build, not by trust.

### What WorkLens does collect

With least-invasive defaults: the name and executable of the foreground application, the window
title, whether the session is active or idle, and — only if a deployer explicitly enables them —
periodic screenshots and browser page titles. Screenshots and URL capture are **off by default**,
work-hours-only mode is **on by default**, and excluded applications and URL patterns are filtered
on the laptop *before* anything is written to the local buffer, so excluded data is never stored
and therefore can never be uploaded. The complete field list, and the notice an employee is owed
before any of it starts, are in [docs/RESPONSIBLE_USE.md](docs/RESPONSIBLE_USE.md) — including a
section addressed to employees rather than to deployers, and a section on **when not to use this at
all**. Retention is configurable per organisation and documented in
[docs/CONFIGURATION.md](docs/CONFIGURATION.md); the database refuses a configuration in which
screenshots would outlive the events they belong to.

### Your obligations as a deployer

Running WorkLens makes you a data controller (or the local equivalent) over your employees'
personal data. Before you deploy it:

1. **Give informed notice.** Tell every affected employee, in writing and in advance, what is
   collected, why, how long it is kept, who can see it, and how they can see their own data. A
   notice template ships in `docs/RESPONSIBLE_USE.md`.
2. **Obtain consent** where your jurisdiction requires it, and record that you did. WorkLens
   itself requires each employee to acknowledge a first-run notice on the device before any
   capture begins, and stores that acknowledgment — but a click-through is a technical control,
   not a substitute for a lawful basis.
3. **Get legal sign-off for your jurisdiction.** Employee monitoring law varies enormously.
   Have counsel confirm your lawful basis, your notice, your retention periods and your
   cross-border transfer position before the first agent is installed.
4. **Enable the minimum you need.** Screenshots in particular are a significant escalation in
   invasiveness. Leave them off unless you can articulate why the timesheet is not defensible
   without them.
5. **Honour access and deletion requests.** Every employee can see their own data in the
   dashboard by design, and WorkLens implements a working hard-delete path for employee-data
   deletion requests.

### India's DPDP Act 2023

India is the **target deployment jurisdiction** for WorkLens, and the **Digital Personal Data
Protection Act, 2023 (DPDP Act)** applies to this processing. Activity data, window titles and
screenshots of an identifiable employee are personal data under the Act. A deployer in India is a
*Data Fiduciary* and must, at minimum, provide a compliant notice, establish a lawful basis for
processing (including the Act's provisions relating to employment purposes), limit collection to
what is necessary for the stated purpose, keep the data only as long as that purpose requires,
implement reasonable security safeguards, honour Data Principal rights of access, correction and
erasure, and be able to report a personal data breach to the Data Protection Board of India.
WorkLens provides the technical building blocks — notice acknowledgment, per-employee self-service
access, configurable retention, hard deletion, encryption at rest and in transit, and an audit log
of who viewed whose data — but the compliance obligation is yours, and this section is not legal
advice. Obtain your own.

### Deploying WorkLens against an employee's knowledge

Do not. Covert use defeats the design intent, is unlawful in many jurisdictions including under
the DPDP Act's notice requirements, and is not something this project supports. The agent shows a
tray icon before it takes its first sample, and **exits rather than run invisibly** if that icon
cannot be created.

---

## Architecture

A Go agent on the employee's laptop buffers samples in SQLite and uploads HMAC-signed batches to
an API Gateway REST API backed by TypeScript Lambdas; PostgreSQL on RDS in a private subnet holds
events and timesheets, S3 holds any screenshots under KMS encryption, EventBridge drives nightly
aggregation, and a Next.js dashboard on Vercel reads it back through Cognito-authenticated
reporting endpoints. The Mermaid diagram, the request-signing scheme and the trust boundaries are
in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), with the request paths and a failure table. The
design decisions and the ten deviations from the original plan are in [docs/PLAN.md](docs/PLAN.md);
the security reasoning, including what is *not* defended, is in [docs/SECURITY.md](docs/SECURITY.md).

## Features

Transparent agent with a tray icon and a first-run acknowledgment; active application and
window-title sampling; idle detection from last-input timing; optional blurred screenshots;
offline-tolerant local buffering with retry and backoff; idempotent batched ingestion; nightly
timesheet aggregation; per-app, per-site, per-category and per-project rollups; CSV payroll export;
role-based access for owner, manager and employee; an employee self-view built from the same
components as the manager's view; configurable retention with a working hard-delete path; and an
audit log of every access to employee data.

Three things are **not** built, stated here rather than left to be discovered: **PDF export** (the
API rejects `format=pdf` with a message saying so), **a rule-preview endpoint** (an owner cannot see
what a project rule would match before saving it), and **on-demand aggregation as an API call** — it
is an operator action against the aggregation function, for the reasons in
[docs/SECURITY.md](docs/SECURITY.md) §2.3.1.

## What the dashboard looks like

No imagery yet, and the reason is worth stating: WorkLens has never been deployed, so any screenshot
would be of seeded local data rather than of the product working. Rather than present that as
evidence, here is the design intent, which the code does implement.

The dashboard is built as **a register, not a console** — a ledger you read, not a surveillance
console. Flat, no shadows, no rounded corners, no dark mode; ledger-green row banding; Archivo for
headings and IBM Plex Sans and Mono for everything else.

Its signature element is the **day-band**: a day drawn as a real 24-hour axis, midnight to midnight,
with recorded active time in ink, idle time in sage, **and everything else left as paper.** The gaps
are visible. You can see the lunch break and the two hours where nothing was recorded. A
surveillance dashboard fills that space with a colour and a judgement; a register leaves it blank,
because blank is what it knows. The same component renders a manager's view of an employee and an
employee's view of themselves, from the same props — because "you see exactly what your employer
sees" should not depend on somebody remembering to keep two components in step.

## Prerequisites

Go 1.23+, Node 22+, Terraform 1.9+, an AWS account with permission to create the resources in
`infra/`, and a Windows 10/11 machine to run the agent. `make bootstrap` verifies what you have
installed and fetches each component's dependencies. CI pins Go 1.23, Node 22 and Terraform 1.9.8,
so those are the versions the build is actually known to work on.

## Deployment

The backend comes up with a remote-state bootstrap, then a `terraform apply`, then a database
migration, a Lambda bundle upload, an agent build and a dashboard deploy — in that order. The
migration runs through the `db-migrate` Lambda rather than from a laptop, because RDS sits in a
private subnet with no public access.

The step-by-step runbook is [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), and what to do once it is
running is [docs/OPERATIONS.md](docs/OPERATIONS.md).

**Nothing here has been deployed.** `terraform validate` passes and the schema has been verified
against a live PostgreSQL 16, but no AWS account has ever run this. Treat the runbook as carefully
derived rather than as tested, and read [docs/SECURITY.md](docs/SECURITY.md) §4 before you rely on
any of it.

## Configuration

Every deployer-supplied value lives in a committed `.env.example` or `terraform.tfvars.example`
template with a comment explaining what it is and where to obtain it. **No secret is in this
repository**: the device root key is generated by Terraform into Secrets Manager, and the database
password is managed by RDS and never enters Terraform state.

Monitoring behaviour is separate from deployment configuration — it is set per organisation in the
dashboard, fetched by the agent, and applied by the agent locally before anything is uploaded. Every
one of those settings defaults to the least-invasive value that still produces a defensible
timesheet. The full reference is [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Development

```sh
make help          # list every available target
make bootstrap     # verify tool versions
make ci            # run exactly what CI runs
```

`CONTRIBUTING.md` covers the per-component workflows, the commit convention, and the privacy
review that any change to data collection must pass.

## Project layout

```
agent/       Go agent for Windows (capture, buffer, upload)
backend/     TypeScript Lambdas, SQL migrations, aggregation
dashboard/   Next.js 15 dashboard
infra/       Terraform for the whole AWS backend
contracts/   the HMAC signing vectors, asserted from both Go and TypeScript
docs/        plan, architecture, agent, API, deployment, configuration,
             operations, security, responsible use
scripts/     the six compliance and build gates CI runs
```

## Security

Vulnerability reporting, supported versions and scope are in [SECURITY.md](SECURITY.md).

[docs/SECURITY.md](docs/SECURITY.md) is the implementation record: how each requirement is met, and —
in §4 — what is deliberately **not** defended and what remains **unverified**. It names the most
serious authorisation defect found in this codebase and how it was found, because a security document
listing only strengths is not useful to anybody deciding whether to trust this.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Licence

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 WorkLens contributors.
