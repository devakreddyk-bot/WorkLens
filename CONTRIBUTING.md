# Contributing to WorkLens

Thanks for considering it. WorkLens is monitoring software, so contributions
carry an obligation beyond "does it work": the project's hard constraints on
what it will never collect are a promise to the employees whose data passes
through it. Two of the sections below — [Privacy review](#privacy-review) and
[Never commit secrets](#never-commit-secrets) — are not optional process, and
both are enforced by continuous integration.

If you are here to report a security vulnerability, stop and read
[SECURITY.md](SECURITY.md) instead. Do not open a public issue.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

---

## Contents

- [What this project will not accept](#what-this-project-will-not-accept)
- [Development environment](#development-environment)
- [Running the tests](#running-the-tests)
- [Commit messages](#commit-messages)
- [Branch naming](#branch-naming)
- [Pull request checklist](#pull-request-checklist)
- [Privacy review](#privacy-review)
- [Never commit secrets](#never-commit-secrets)
- [Code style](#code-style)
- [Repository layout](#repository-layout)

---

## What this project will not accept

These are product constraints. A pull request that implements any of them will
be closed regardless of quality, and the same applies to a change that makes
one of them possible "if configured".

- Keystroke content, key codes, or any use of raw-input or keyboard-hook APIs.
- Password capture, by any mechanism.
- Clipboard reads.
- Webcam or microphone capture.
- A covert, hidden, or silently-installed mode; anything that removes the tray
  icon, suppresses the first-run notice, or lets capture start before the
  employee has acknowledged it.
- Removing an employee's ability to see their own data.
- Turning any of `scripts/check-privacy.sh`, `scripts/check-iam.sh` or
  `scripts/check-readme.sh` into a warning instead of a failure.

Idle detection uses `GetLastInputInfo`, which returns only a timestamp. If a
change would need more than a timestamp to detect activity, it is out of scope.

---

## Development environment

Clone the repository and run:

```sh
make bootstrap
```

`bootstrap` verifies your tool versions, tells you exactly what to install if
something is missing or too old, and then installs each component's
dependencies. `make help` lists every target.

### Required tools

| Tool | Minimum | Why |
|---|---|---|
| **Go** | **1.23** | The agent. Uses `golang.org/x/sys/windows` and builds with `CGO_ENABLED=0`. |
| **Node.js** | **22** | Lambdas (Node 22 runtime, ARM64) and the Next.js 15 dashboard. npm ships with it. |
| **Terraform** | **1.9** | All AWS infrastructure. |
| `zip` | any | Packaging Lambda bundles. Preinstalled on macOS and on GitHub runners. |
| `git` | 2.30+ | — |
| `gitleaks` | latest | Optional locally, enforced in CI. `brew install gitleaks`. |

An AWS account is only needed to deploy; you can build, lint and test
everything without one.

### Per-component setup

#### `agent/` — Go, Windows target

```sh
cd agent
go mod download
go build ./...                                     # host build, compile check
go test ./... -race
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build ./...   # what actually ships
```

Or from the repository root, `make agent-windows`, which writes
`bin/worklens-agent.exe` and `bin/worklens-agentctl.exe`.

Two notes that will save you time. The SQLite driver is `modernc.org/sqlite`
(pure Go) precisely so `CGO_ENABLED=0` cross-compilation keeps working — do not
swap in `mattn/go-sqlite3`. And the Windows-specific code lives behind the
`internal/platform` interface with a `darwin` stub, so a change to capture
behaviour goes behind that interface, not into `main`.

You can compile and unit-test the agent on macOS or Linux, but capture
behaviour, the tray icon and the Scheduled Task can only be verified on real
Windows. Say which you did in the pull request.

#### `backend/` — TypeScript Lambdas

```sh
cd backend
npm ci
npx tsc --noEmit
npx eslint .
npx vitest run --coverage
npx vitest             # watch mode while developing
```

Copy `.env.example` to `.env` and fill it in for anything that talks to a
database. Migrations are forward-only numbered SQL files; apply them with
`make migrate` (which runs `backend/scripts/migrate.ts`). Never edit a
migration that has been applied anywhere — add a new one.

#### `dashboard/` — Next.js 15

```sh
cd dashboard
npm ci
npx next dev            # or: make dashboard-dev
npx tsc --noEmit
npx eslint .
npx next build
```

Copy `.env.example` to `.env.local`. Data fetching belongs in Server
Components; Client Components are for charts and interactive filters. The
Cognito token must not reach client JavaScript beyond the auth callback.

#### `infra/` — Terraform

```sh
make tf-fmt         # format
make tf-validate    # init -backend=false + validate, both stacks
make tf-plan        # plan the root stack into infra/tfplan
```

`infra/bootstrap/` creates the remote state bucket and lock table and is
applied once, before the root stack. Copy `terraform.tfvars.example` to
`terraform.tfvars` — it is gitignored, and it must stay that way.

Every new IAM policy must be scoped to explicit ARNs. `make check-iam` fails on
`Resource = "*"` unless the line, or the line directly above it, carries a
justification:

```hcl
# iam-wildcard-ok: ec2:CreateNetworkInterface has no resource-level
# permissions; constrained by the aws:RequestedRegion condition below.
resources = ["*"]
```

An annotation with no reason after the colon counts as no annotation.

---

## Running the tests

From the repository root:

| Command | What it runs |
|---|---|
| `make test` | Every test suite that exists. |
| `make agent-test` | `go test ./... -race -count=1` in `agent/`. |
| `make backend-test` | `vitest run --coverage` in `backend/`. |
| `make dashboard-test` | `vitest run --coverage` in `dashboard/`. |
| `make lint` | gofmt check, `go vet`, `tsc --noEmit`, eslint, `terraform fmt -check`. |
| `make check-privacy` | Forbidden capture APIs anywhere in source. |
| `make check-iam` | Unjustified IAM resource wildcards. |
| `make check-readme` | The README's responsible-use section is present and complete. |
| `make check-functions` | `backend/functions.json` and the Terraform catalogue agree. |
| `make check-migrations` | Every migration is bundled into the `db-migrate` Lambda. |
| `make check-routes` | The dashboard calls only endpoints the backend serves. |
| `make ci` | Everything above, in the order CI runs it. |

`make ci` is what you should run before pushing. Any target whose component
does not exist yet prints `skipping: <dir>/ not yet present` and succeeds, so
these commands work at every stage of the build.

### What needs a test

- **Aggregation logic** (`backend/src/aggregation/rollup.ts`) — it is a pure
  function so that it can be tested hard. Empty days, all-idle days, DST
  transitions and midnight-spanning sessions are the cases that break.
- **API handlers** — at least the auth, validation and rejection paths.
- **Privacy rules** (`agent/internal/privacy`) — a privacy control that
  silently no-ops is worse than no control. The same applies to screenshot
  blur, which is tested by asserting the variance of a high-contrast fixture
  drops after blurring.
- **HMAC request signing** — the agent and the backend share one fixture file
  of signing vectors, so the contract cannot drift silently. If you change the
  canonical request format, change the fixture and both sides in one commit.

---

## Commit messages

WorkLens uses [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).

```
<type>(<scope>)!: <description>

[optional body]

[optional footer(s)]
```

- **type** — required, from the table below, lowercase.
- **scope** — optional but strongly preferred; use the component or module:
  `agent`, `backend`, `dashboard`, `infra`, `docs`, `ci`, `deps`, or something
  narrower such as `agent/privacy`, `backend/ingest`, `infra/waf`.
- **`!`** — append before the colon for a breaking change, and explain the
  migration in a `BREAKING CHANGE:` footer.
- **description** — imperative mood, lowercase, no trailing full stop, wrapped
  at 72 characters. "add", not "added" or "adds".

### Allowed types

| Type | Use for |
|---|---|
| `feat` | A new capability a user or deployer can observe. |
| `fix` | A bug fix. |
| `docs` | Documentation only, including `README.md` and `docs/`. |
| `test` | Adding or correcting tests, with no production-code change. |
| `refactor` | Restructuring with no behaviour change and no new feature or fix. |
| `perf` | A change that measurably improves speed, memory or cost. Say by how much. |
| `style` | Formatting and whitespace only — no logic. |
| `build` | Build system, Makefile, esbuild config, Go build flags. |
| `ci` | GitHub Actions workflows and the scripts they run. |
| `chore` | Maintenance that fits nowhere else, including dependency bumps. |
| `revert` | Reverting an earlier commit; name it in the body. |

Nothing else. `wip`, `update` and `misc` are not types.

### Worked examples

Good:

```
feat(agent): coalesce consecutive identical window samples

Samples with the same app, title and idle state now collapse into one
event with a summed duration_seconds. On a typical eight-hour day this
cuts uploaded event volume by roughly 15x, which keeps the SQLite buffer
inside its 250 MB cap on a laptop that has been offline for a fortnight.
```

```
fix(backend/ingest): treat a duplicate batch as success

The idempotency-key insert used ON CONFLICT DO NOTHING but then read the
returned row unconditionally, so a retried batch produced a 500 and the
agent retried it forever. Return 200 with duplicate:true instead, so the
agent drops the batch.

Closes #142
```

```
docs(responsible-use): add the DPDP Act notice template
```

```
refactor(agent/platform): move idle detection behind the Platform interface
```

```
perf(backend/reporting): read timesheet_app_totals instead of scanning events

The /overview query dropped from 2.4 s to 40 ms on 90 days of data for
50 employees.
```

```
feat(backend)!: require Idempotency-Key on POST /v1/device/events

BREAKING CHANGE: batches without an Idempotency-Key header are now
rejected with 400. Agents older than v0.2.0 must be upgraded before this
deploys; the header has been sent by every agent since v0.1.0, so the
practical impact is limited to hand-rolled clients.
```

Not acceptable:

```
Fixed the bug                 (no type; past tense; which bug?)
feat: stuff                   (no scope; says nothing)
update agent.go               (not a Conventional Commit at all)
feat(agent): Add keystroke logging.   (violates a hard constraint, and
                                       capitalised, and ends in a full stop)
```

---

## Branch naming

```
<type>/<short-kebab-description>
<type>/<issue-number>-<short-kebab-description>
```

The `<type>` is the same set as the commit types. Examples:

```
feat/agent-sample-coalescing
fix/142-duplicate-batch-500
docs/dpdp-notice-template
chore/deps-bump-next-15-4
ci/cache-terraform-providers
```

Do not commit to `main` directly. Keep one logical change per branch; if the
description needs an "and", it is probably two branches.

---

## Pull request checklist

The [pull request template](.github/PULL_REQUEST_TEMPLATE.md) is the
authoritative version and it is prefilled for you. In summary, before you mark
a pull request ready:

1. **`make ci` passes locally.** If something fails for an environmental
   reason, say so in the description.
2. **Commits follow Conventional Commits** and the branch is named as above.
3. **New behaviour has tests.** Aggregation and handler changes always need
   unit tests; see [What needs a test](#what-needs-a-test).
4. **Privacy review completed** — see the next section. This is mandatory for
   any change that touches data collection, and the template will not let you
   skip it.
5. **Security boxes ticked**: no new secrets, IAM scoped to explicit ARNs,
   parameterised SQL only, request bodies validated at the handler boundary,
   `org_id` taken from the verified token and never from user input.
6. **Documentation updated** — `README.md`, the relevant file in `docs/`, and
   the comment on any new variable in a `.env.example`.
7. **`CHANGELOG.md` has an entry** under `## [Unreleased]` for anything a user
   or deployer would notice.
8. **No secrets, real ARNs, AWS account IDs, employee names or captured
   activity in the diff** — including in test fixtures and screenshots.
9. **You have read your own diff.** Line by line.

Reviewers will look at the privacy and security sections first, and at whether
the change is the smallest one that solves the problem.

---

## Privacy review

**Any pull request that touches data collection must state what new data is
collected and why.** This is a hard requirement, not a courtesy, because
WorkLens' hard constraints are a promise made to people who did not choose to
install it. A deployer relies on the README to write the notice they give
their employees; if the code starts collecting something the README does not
mention, that notice becomes false.

A change "touches data collection" if it does any of the following:

- Adds or widens a field captured on the device — an event field, a screenshot
  attribute, a health or diagnostic value.
- Adds or alters a column, table or S3 key that holds employee data.
- Changes when capture happens: sampling interval, work-hours evaluation,
  exclusion matching, idle handling, or the order in which privacy filters run
  relative to writing to the buffer.
- Changes who can read employee data, or which reads are audited.
- Changes a retention window, a deletion path, or an export.
- Adds an entry to `scripts/privacy-allowlist.txt`, or a
  `# iam-wildcard-ok:` annotation that widens access to employee data.

For such a pull request, the description must answer, in the template's
privacy-impact section:

1. **What** new data is collected, stored or exposed — the exact fields.
2. **Why** it is necessary: what question about a timesheet cannot be answered
   without it. "It might be useful later" means do not collect it.
3. **Who** can see it, and whether that access writes an `audit_log` row.
4. **How long** it is retained, and which retention setting governs it.
5. **Confirmation** that the hard constraints still hold, and that exclusion,
   work-hours and blur checks still run on the device *before* anything is
   written to the local buffer — so excluded data is never persisted and
   therefore can never be uploaded.

If a change alters what a deployer must tell employees, it must also update
`README.md` and `docs/RESPONSIBLE_USE.md` in the same pull request. A reviewer
other than the author has to agree with the reasoning. When in doubt, collect
less; the least-invasive option that still produces a defensible timesheet is
always the correct default.

`scripts/check-privacy.sh` enforces the mechanical part of this in CI: it fails
the build if any source file references a forbidden capture API, and fails if
the string `keystroke` appears in executable SQL. It cannot judge intent —
that is what the review is for.

---

## Never commit secrets

Nothing in this repository may contain a real credential. Not in a test, not in
a fixture, not in a comment, not "temporarily", not in a commit you intend to
amend. Git history is public and permanent.

Specifically, never commit: AWS access keys or session tokens; a device secret
or the device root key; an enrolment token (`wlen_...`); a Cognito client
secret, ID token or refresh token; a database password or connection string
with credentials; a `.pem`, `.key`, `.p12` or `credentials.json`; a
`terraform.tfstate` file (state contains secrets in plaintext); a
`terraform.tfvars` file; a `.env` file; or a captured screenshot or window
title from a real person.

The controls, in order:

1. **`.gitignore`** already covers `.env*` (except `.env.example`), `*.tfvars`
   (except `*.tfvars.example`), `*.tfstate*`, `*.pem`, `*.key`, `*.p12`,
   `credentials.json`, `*.db`/`*.sqlite*`, and build artefacts. If you add a
   tool that writes secrets, add its patterns in the same commit.
2. **`.env.example` files** carry every deployer-supplied value as a
   placeholder with a comment saying what it is and where to obtain it. Real
   values live only in your untracked `.env`, in AWS Secrets Manager, or in
   GitHub Actions secrets.
3. **[gitleaks](https://github.com/gitleaks/gitleaks)** runs in CI over the
   **full history** on every push and pull request, and the build fails on a
   finding. Run it yourself before pushing:

   ```sh
   brew install gitleaks          # or see the project's install docs
   gitleaks detect --no-banner    # scans committed history
   gitleaks protect --staged      # scans what you are about to commit
   ```

   Wiring `gitleaks protect --staged` into a local `pre-commit` hook takes a
   minute and is strongly recommended.

**If you do commit a secret:** treat it as compromised the moment it is
pushed. Rotate or revoke it first — rewriting history does not un-leak
anything, because the value may already have been fetched. Then tell a
maintainer, and only then worry about the history. For AWS keys, deactivate
them in IAM. For a device secret, revoke the device (`devices.revoked_at`),
which takes effect on that device's next request. For the device root key,
publish a new key version and re-enroll.

---

## Code style

Formatters decide; do not argue with them in review. `make fmt` applies
everything, `make lint` checks it.

- **Go** — `gofmt` (CI fails on unformatted files) and `go vet`. Wrap errors
  with `fmt.Errorf("...: %w", err)`. Never log a secret; the agent's logger
  redacts known secret shapes and has a test asserting a known secret never
  appears in output — keep it that way.
- **TypeScript** — `tsc --noEmit` with strict mode, and eslint. No `any` that
  a reviewer has to accept on faith. Validate at the boundary with Zod using
  `.strict()` so unknown keys are rejected. Repository functions take `orgId`
  as their first parameter, always from the verified token.
- **SQL** — lowercase keywords, parameterised queries only (`pg` positional
  parameters). No template literals inside a `query(` call; CI greps for them.
  Migrations are forward-only.
- **Terraform** — `terraform fmt`. One resource per logical unit, modules under
  `infra/modules/`, no `Resource = "*"` without an annotation.
- **Comments** — explain *why*, not *what*. The places that most need a comment
  are the ones where the obvious implementation would be wrong: the startup
  order in the agent's `main`, the idle-suppression of window titles, and the
  ordering of privacy filters relative to buffer writes.
- **Whitespace and line endings** — governed by `.editorconfig` and
  `.gitattributes`. Enable EditorConfig support in your editor.

---

## Repository layout

```
agent/       Go agent for Windows: capture, privacy filters, buffer, upload
backend/     TypeScript Lambdas, SQL migrations, aggregation, tests
dashboard/   Next.js 15 App Router dashboard
infra/       Terraform: root stack, modules, and the state bootstrap stack
docs/        plan, architecture, API, deployment, operations, responsible use
scripts/     compliance gates run by CI and by `make ci`
```

`docs/PLAN.md` is the design document. It records every deviation from the
original requirements together with the reason — read the relevant deviation
before changing something that looks odd; most oddities are load-bearing.
