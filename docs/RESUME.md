# RESUME — WorkLens build state

**Written:** 2026-08-18 · **Repo:** `/Users/devakrkunthuri/worklens` (git, branch `main`)
**Phases complete:** 0 and 1. **Phase 2: device API done, two handlers remain.**

This file is refreshed at every checkpoint. It assumes the reader has **zero memory** of
the session that produced it.

---

## 1. Mission and hard constraints

Build **WorkLens** — a transparent employee time-tracking and activity-monitoring system
for a single-company deployment. A Go agent runs on company-issued Windows laptops,
samples work activity, buffers it locally, and ships it to an AWS backend. A scheduled job
rolls raw events into per-employee daily timesheets. A Next.js dashboard lets an owner
review and export them for payroll, and lets every employee see their own data.

The original requirements are `docs/MASTER_BUILD_PROMPT.md` (recovered from a PDF). The
design and every deviation from it are `docs/PLAN.md`. Runtime behaviour is
`docs/ARCHITECTURE.md`.

### Non-negotiable constraints

| Constraint | How it is enforced today |
|---|---|
| **No keystroke content capture.** Detect input *activity level* only (was there input in the last N seconds), never which keys. | Idle detection will use `GetLastInputInfo`, which returns only a timestamp. No column exists for key data; `scripts/check-privacy.sh` fails the build on `SetWindowsHookEx`, `GetAsyncKeyState`, `RegisterRawInputDevices` and friends in any `.go/.ts/.tsx/.js/.sql/.tf` file. |
| No password capture, no webcam, no microphone, no clipboard content. | Same gate; `OpenClipboard`, `GetClipboardData`, `waveIn`, `IAudioCaptureClient`, `VideoCapture` are all banned strings. |
| **Agent must be visible and transparent.** Tray icon, first-run notice the employee acknowledges, clear running indicator. | Not built yet (Phase 3). Server side is done: `withAcknowledgedNotice` in `backend/src/middleware/deviceAuth.ts` rejects activity data from a device with no recorded acknowledgment, so a tampered agent cannot bypass it. |
| **Least-invasive defaults.** | Column defaults in `monitoring_config`: screenshots **off**, URL capture **off**, work-hours-only **on**, titles on, 60 s sampling. |
| Privacy rules honoured **locally**, before upload. | Phase 3. The agent filters between capture and the SQLite buffer, so excluded data is never persisted at all. |
| Secure by default. | See §6 of `docs/PLAN.md`; status per item in §7 below. |
| Responsible-use documentation mandatory. | `README.md` has the full `## Responsible & Lawful Use` section; `scripts/check-readme.sh` fails the build if it or any of *keystroke, password, webcam, microphone, consent, DPDP* goes missing. |

Also enforced **in the database**, so no application bug can route around it:

- `activity_events_idle_no_attribution_chk` — an idle event may not carry `app_name`,
  `app_exe`, `window_title`, `url_host` or `url_title`. Idle minutes cannot be used to
  infer what was on screen.
- `monitoring_config_retention_chk` — screenshots may not outlive the events that explain
  them.
- `timesheets_totals_chk` — `total = active + idle`.
- `worklens_app` has `INSERT`/`SELECT` on `audit_log` but **no `UPDATE` or `DELETE`**, and
  cannot create, alter or drop anything.

---

## 2. Stack, and the ten deviations

Agent: **Go 1.23**, Windows first, `CGO_ENABLED=0`, SQLite via `modernc.org/sqlite`
(pure Go — `mattn/go-sqlite3` would break static cross-compilation).
Backend: **TypeScript on Node 22, ARM64 Lambda**. Database: **RDS PostgreSQL 16**,
`db.t4g.micro`, private subnets, IAM auth. Storage: **S3 + SSE-KMS**. Auth: **Cognito**.
IaC: **Terraform**. Dashboard: **Next.js 15 App Router + Tailwind v4 + Recharts** on Vercel.
Region default **ap-south-1**.

`docs/PLAN.md` §1 states all ten deviations in full. The ones a new session must not
undo:

| # | Deviation | Why |
|---|---|---|
| D1 | Lambda in TypeScript, not Go | Shares Zod request schemas with the dashboard as real code, so the contract cannot drift. Go stays where a static binary and Win32 syscalls are the requirement. |
| **D2** | **API Gateway REST API, not HTTP API** | **AWS WAF cannot attach to an HTTP API**, and WAF is a §9 requirement. This corrects the spec. |
| D3 | HMAC request signing, not bearer JWT | Authenticates the body as well as the device; bounds replay; revocation is a DB write, not a TTL wait. |
| D4 | Device secrets derived, not stored | No device credential exists in the database at all. |
| **D5** | **Agent is a per-user logon Scheduled Task, NOT a Windows service** | **Session-0 isolation: from a service, `GetForegroundWindow` returns nothing useful, `GetLastInputInfo` reports no input, and screen capture is blank. A service-based agent would report every employee permanently idle.** This corrects the spec. |
| D6 | No NAT gateway | RDS IAM auth (local signing, no network call) + free S3 gateway endpoint + Secrets Manager and Cognito interface endpoints. Saves ~$33/mo. |
| D7 | Admin MFA enforced server-side | Cognito pool MFA is pool-wide, so `REQUIRED` would force TOTP on employees just to see their own timesheet. Pre-token-generation Lambda injects `wl:mfa`; the API rejects admin routes without it. |
| D8 | Cert pinning targets CA SPKI, not the leaf | ACM rotates leaves; pinning one would break the fleet roughly annually. |
| D9 | URL capture is title-derived and off by default | Scoped exactly as the spec asked. Limits documented rather than hidden. |
| D10 | Screenshot blur implemented in-repo | It is a privacy control; if it silently no-ops, sensitive pixels ship. Needs its own test against a fixture. |

### An eleventh deviation, found during Phase 2 — read this before touching auth

**There is no `device-authorizer` Lambda, and there must not be one.** The Phase 0 plan
put HMAC verification in an API Gateway `REQUEST` authorizer. That cannot work: a REST API
Lambda authorizer is **not given the request body**, and the signature covers
`sha256(body)`. Verification happens in-handler via `withDeviceAuth`
(`backend/src/middleware/deviceAuth.ts`), and device routes are `authorization = "NONE"`
at the gateway. This is also strictly better — every request carries a fresh nonce, so an
authorizer's result cache would miss every time, costing an extra Lambda invocation per
request for nothing. Already removed from `backend/functions.json`,
`infra/modules/lambda/`, and `infra/modules/api/`.

---

## 3. Current repo tree

```
worklens/
  README.md  LICENSE  CONTRIBUTING.md  CODE_OF_CONDUCT.md  SECURITY.md
  CHANGELOG.md  Makefile  .gitignore  .editorconfig  .gitattributes
  .github/workflows/ci.yml  .github/dependabot.yml  .github/PULL_REQUEST_TEMPLATE.md
  .github/ISSUE_TEMPLATE/{bug_report.md,feature_request.md,config.yml}

  scripts/check-privacy.sh      privacy gate (executable, passing)
  scripts/check-iam.sh          IAM wildcard gate (executable, passing)
  scripts/check-readme.sh       responsible-use gate (executable, passing)
  scripts/privacy-allowlist.txt (empty by design)

  docs/MASTER_BUILD_PROMPT.md   the recovered requirements
  docs/PLAN.md                  Phase 0 plan — the design authority
  docs/ARCHITECTURE.md          runtime behaviour, request paths, failure table
  docs/RESUME.md                this file

  backend/
    package.json tsconfig.json eslint.config.js vitest.config.ts .env.example
    functions.json              14 Lambdas — SHARED with infra/, do not let it drift
    migrations/0001_init.sql    22 tables, the whole schema
    migrations/0002_org_bootstrap.sql   category template + wl_seed_org_defaults()
    migrations/0003_app_role.sql        worklens_app / worklens_migrator + grants
    migrations/README.md
    scripts/migrate.ts          checksum-enforcing forward-only runner
    scripts/bundle.ts           esbuild + deterministic zip writer
    src/shared/{config,errors,logger,db,signature,deviceSecret,http}.ts
    src/middleware/deviceAuth.ts
    test/setup.ts
    test/shared/{signature,deviceSecret,logger}.test.ts   102 tests, passing

  infra/
    versions.tf main.tf variables.tf outputs.tf backend.tf terraform.tfvars.example
    bootstrap/{versions,variables,main,outputs}.tf        remote-state bucket + lock table
    modules/network database storage auth lambda lambda/modules/function
            api waf scheduling observability alarms       (each main/variables/outputs.tf)
```

Not yet created: `agent/`, `dashboard/`, `backend/src/repositories/`,
`backend/src/schemas/`, `backend/src/handlers/`, `backend/src/aggregation/`,
and `docs/{API,AGENT,DEPLOYMENT,CONFIGURATION,SECURITY,RESPONSIBLE_USE,OPERATIONS}.md`.

---

## 4. What is DONE

### Phase 0 — complete
`docs/PLAN.md`: stack with justified deviations, architecture diagram, full data model,
API surface, agent design, dashboard page map, security plan mapped to §9 line by line,
repo structure, ordered Phase 1–7 breakdown, cost model (~$37/mo at 50 devices),
checkpoint discipline.

### Phase 1 — complete, committed as `e50f98a`

**Database.** 3 migrations, 22 tables. Verified by *running* them against a local
PostgreSQL 16, not by inspection:
- all three apply clean; re-run reports "up to date"
- 0 columns match `key(stroke|log)|clipboard|webcam|microphone|audio|video`
- each privacy CHECK constraint confirmed to reject the case it exists for (an idle event
  with `window_title: 'Internet Banking - Chrome'` is rejected; the same event without
  attribution is accepted)
- `worklens_app` confirmed unable to `UPDATE audit_log`, `DELETE FROM audit_log`,
  `DROP TABLE`, `CREATE TABLE`, or read `schema_migrations`
- tampering with an applied migration file aborts the runner with a checksum diff
- `wl_seed_org_defaults()` is idempotent; seeds 50 categories and one config row at the
  least-invasive defaults

**Infrastructure.** Eleven modules, one `terraform apply`. `terraform fmt -check` and
`validate` pass on both root modules (`infra/` and `infra/bootstrap/`). Includes a `check`
block that fails the plan, naming the file, when a Lambda zip is missing.

**Repo hygiene.** MIT licence, Contributor Covenant, security policy, Keep-a-Changelog,
27-target self-documenting Makefile, CI with six jobs (agent / backend / dashboard /
terraform / gitleaks / compliance), issue and PR templates with a privacy-impact question,
Dependabot.

### Phase 2 — partially complete, committed as `85a9736`

Done and verified (`tsc --noEmit` clean, `eslint --max-warnings 0` clean, 102 tests pass):

| File | What it owns |
|---|---|
| `src/shared/config.ts` | Zod-validated env, parsed at module load. Refuses: no DB credential of either kind; `NONCE_RETENTION_SECONDS <= HMAC_TIMESTAMP_SKEW_SECONDS`; `LOG_REQUEST_BODIES` in production. |
| `src/shared/errors.ts` | The whole error vocabulary. Every auth failure that could be probed returns identical wording, so device ids cannot be enumerated. |
| `src/shared/logger.ts` | JSON lines. Redacts credentials by key name at any depth; treats window titles as personal data; never renders Buffer contents. |
| `src/shared/db.ts` | Pool (`max: 1`) + RDS IAM token, both memoised as **promises** so concurrent cold-start callers share one signing pass. `query`/`queryOne`/`transaction`. No API that accepts an interpolated string. |
| `src/shared/signature.ts` | Canonical form, signing, constant-time compare, header extraction. Pure — no I/O. |
| `src/shared/deviceSecret.ts` | Root-key version map from Secrets Manager (one fetch per container), derivation, `currentKeyVersion()`. |
| `src/shared/http.ts` | `withHandler`: request id, entry/exit logging, error→response mapping, security headers, body parsing with a size cap. |
| `src/middleware/deviceAuth.ts` | `authenticateDevice`, `withDeviceAuth`, `withAcknowledgedNotice`. |

**The device API is also complete** (committed as `98f31f7`; 182 tests pass, `tsc` and
`eslint --max-warnings 0` clean, all four gates pass):

- `src/repositories/{executor,devices,enrollment,events,screenshots,monitoringConfig,audit}.ts`
- `src/schemas/{common,parse,enroll,events,screenshots,heartbeat}.ts`
- `src/handlers/device/{enroll,config,ingestEvents,screenshotPresign,screenshotComplete,heartbeat,noticeAck}.ts`
- `test/helpers/{dbMock,deviceRequest}.ts` and five handler test files

Decisions in there worth not re-litigating:

- **`category` and `project_id` are rejected from the device**, though the columns exist.
  They are derived server-side from `app_categories` / `project_rules` at aggregation;
  accepting them would let a tampered agent label its own time.
- **`notice-ack` takes no body.** A client-supplied timestamp is self-reported, and that
  column is the deployer's evidence a person was informed. Idempotent via
  `coalesce(notice_acknowledged_at, now())` with a CTE reporting the pre-update value, so
  the audit row is written exactly once.
- **Health counters are logged, not stored.** `devices` has no column for buffer depth or
  dropped events. Adding one is a schema decision, not a handler's call.
- **Enrolment inserts the device before marking the token used**, because
  `enrollment_tokens_used_chk` and the FK on `used_by_device_id` require it in that order.
  The losing racer's `UPDATE ... WHERE used_at IS NULL` returns zero rows and aborts the
  transaction, discarding its device row.
- **The ingest quota charges rejected batches too**, or exceeding the limit would make
  hammering the endpoint free.
- **`bytes` is `byte_count`** in the presign request, matching the column
  (`docs/PLAN.md` §2 says `bytes`).

Two S3 presigner behaviours that would have failed in production, now pinned by tests:
`content-type` sits in the presigner's default `unsignableHeaders`, so it must be named in
`signableHeaders` or the URL does not constrain what gets uploaded — which is the entire
point of a constrained presign. And with SDK defaults `getSignedUrl` signs a CRC32 of the
empty request body into the URL, so every real upload fails a checksum mismatch;
`requestChecksumCalculation: 'WHEN_REQUIRED'` is correctness, not tuning.

Also worth knowing: `Date.parse('2026-02-30T00:00:00Z')` does **not** return NaN in V8 — it
rolls forward to 2 March, which would silently move an event into a different timesheet
day. `src/schemas/common.ts` validates the day against the month's real length.

---

## 5. What is IN PROGRESS

**Nothing is half-written.** Both background agents that were running at the previous
checkpoint have finished and their work is committed and independently verified:

- All 11 Terraform module READMEs are present.
- The device API is complete — see §4. I re-ran `tsc`, `eslint --max-warnings 0` and
  `vitest` myself, audited every repository query for interpolation and `org_id` scoping,
  and confirmed the derived device secret is returned but never persisted.

Phase 2 has exactly two files left, both listed first in §6.

## 6. What is NEXT, in order

**Finish Phase 2.**
1. Confirm or build the repositories, schemas and device handlers described in §5.
2. `src/handlers/jobs/dbMigrate.ts` — the in-VPC migration Lambda. RDS has no public
   access, so this is the *only* way migrations reach the deployed database. It imports the
   `.sql` files as text (the bundler already sets `loader: { '.sql': 'text' }`); factor the
   ledger/checksum logic out of `scripts/migrate.ts` into `src/shared/migrations/` so both
   callers share one implementation.
3. `src/handlers/auth/preTokenGeneration.ts` — reads org, role and `employee_id` from
   `users`, calls `AdminGetUser` for MFA status, injects `wl:*` claims (D7). It is in the
   VPC and reaches Cognito through the interface endpoint.
4. `make backend-build` must succeed — it fails today because handler entry files listed in
   `functions.json` do not all exist yet. That is deliberate strictness, not a bug.

**Phase 3 — Agent (Windows).** The largest remaining piece. `docs/PLAN.md` §5 has the
package layout and §9 the ordered tasks. Non-obvious points that will cost a day each if
missed:
- Startup order is a privacy control: config → notice gate → tray (exit non-zero if the
  tray cannot be created) → capture goroutines. Capture must not start before the notice
  is acknowledged.
- The privacy filter sits between capture and the SQLite buffer, so excluded data is never
  written to disk. Not between buffer and upload.
- An idle sample must drop app and title before storing, or the server's CHECK constraint
  rejects the batch.
- Install as a **logon Scheduled Task**, not a service (D5).
- Write the signing implementation against `backend/test/shared/signature.test.ts`'s
  construction, and add a shared fixture file so both languages are pinned to the same
  vectors. This contract silently breaking is the most likely integration failure.

**Phase 4** — `src/aggregation/rollup.ts` as a *pure* function (timezones, DST, sessions
spanning midnight, all-idle days, project-rule precedence), plus `runner.ts`, the reporting
handlers, CSV export, and the retention and nonce sweepers.

**Phase 5** — the dashboard: Cognito auth, RBAC, the fourteen routes in `docs/PLAN.md` §7,
CSV and PDF export. PDF renders client-side with `@react-pdf/renderer`, deliberately not in
Lambda.

**Phase 6** — walk §9 line by line recording evidence in `docs/SECURITY.md`; fill test gaps;
CI green on all four toolchains.

**Phase 7** — full README, `docs/RESPONSIBLE_USE.md` (what is and is not collected, an
employee notice template, DPDP Act obligations), `DEPLOYMENT.md`, `CONFIGURATION.md`,
`OPERATIONS.md`, `API.md`, `AGENT.md`; tag `v0.1.0`.

---

## 7. Key decisions and gotchas discovered so far

**Corrections to the specification.** Three, all documented above: WAF cannot attach to an
HTTP API (D2); a session-0 Windows service cannot see the interactive desktop (D5); a REST
API Lambda authorizer never receives the request body, so HMAC verification cannot live in
one (§2, eleventh deviation).

**Terraform dependency cycles.** Two exist naturally and are broken deliberately — do not
"tidy" either away:
- `storage` needs the CloudTrail ARN and `observability` needs the screenshot bucket ARN.
  Both are computed as strings in `infra/main.tf` locals from account, region and prefix.
- Alarms need identifiers of resources that encrypt with `observability`'s CMKs. That is
  why `modules/alarms/` is separate and applied last.

**`backend/functions.json` is a second hand-maintained list, not a source Terraform
reads.** An earlier comment in it claimed Terraform consumed it with
`jsondecode(file(...))`; nothing does. Adding a function means adding it there *and* to
`infra/modules/lambda/main.tf`'s catalogue. `scripts/check-functions.sh` (in `make ci` and
in the CI compliance job) fails the build when they disagree, naming which side is missing
what. Both currently list the same 14.

**`# iam-wildcard-ok:` is a build gate.** `scripts/check-iam.sh` fails on
`Resource = "*"` unless annotated with a reason, **on the same line or the line directly
above** — a marker three lines up does not count. KMS key policies legitimately need the
wildcard (it resolves to the key the policy is attached to) and are annotated.

**`scripts/check-privacy.sh` skips comments and SQL string literals.** That is why
`0001_init.sql` can carry a comment saying there is no column for keystroke content without
failing its own gate. Non-comment, non-literal SQL still fails on a bare `keystroke`.

**Local Postgres for verification.** Homebrew `postgresql@16`. Two macOS traps: the socket
directory path must be short (`-k /tmp/wlpg`, not a deep temp path — 103-byte limit), and
`LC_ALL=C` must be exported or the postmaster dies with "became multithreaded during
startup". Start it with:
```bash
export PATH=/opt/homebrew/opt/postgresql@16/bin:$PATH LC_ALL=C
pg_ctl -D <datadir> -o "-p 55432 -k /tmp/wlpg -c listen_addresses=127.0.0.1" -l <datadir>/server.log start
DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=worklens DB_MIGRATOR_USER=postgres \
  DB_PASSWORD=x DB_SSL_MODE=disable npx tsx scripts/migrate.ts
```

**Terraform is at `~/.local/bin/terraform`** (1.14.5), installed as a prebuilt binary
because the Homebrew formula wants to compile and this machine's Command Line Tools are too
old. `export PATH=$HOME/.local/bin:$PATH`. Go 1.26.6 is on the Homebrew path.

**Lint strictness is deliberate and CI matches it.** `--max-warnings 0`, so a missing
explicit return type on an exported function fails the build. `require-atomic-updates`
caught a genuine double-fetch in the memoisation of the pool, the IAM token and the root
keys; all three now memoise the promise, not the resolved value. Do not "fix" that by
disabling the rule.

**The database is not reachable from a laptop.** Private subnets, no public access. The
`db-migrate` Lambda exists for exactly this reason (`create_db_migrate_function`, default
true).

**`AGGREGATION_LOOKBACK_DAYS` defaults to 3, not 1**, because an agent offline overnight
uploads yesterday's events today and that late data must land in the right day's timesheet.
Aggregation is an idempotent upsert, so recomputing a settled day is free.

### Defects found and fixed after the Phase 2 commit

A documentation pass over the Terraform surfaced seven real problems. Five are fixed;
two are recorded below as open.

Fixed:
1. **Critical — every device route lacked the device-root-key grant.** Removing the device
   authorizer moved HMAC verification into each handler, but only `enroll` carried
   `stmt_read_root_key` / `stmt_decrypt_secrets` and `DEVICE_ROOT_KEY_SECRET_ARN`. Every
   other authenticated device request would have thrown at
   `requireConfig('DEVICE_ROOT_KEY_SECRET_ARN')` and returned 500. Now expressed once as
   `local.device_route_env` / `local.device_route_policies` and applied to all six.
2. `modules/lambda`'s file header still claimed pre-token-generation runs outside the VPC.
3. `modules/api` hard-coded `cors_allowed_origins[0]`, so with several origins configured
   every one but the first silently failed in a browser. A MOCK preflight cannot return a
   conditional origin, so the variable is now validated to hold exactly one entry, with the
   message explaining what supporting more would require. Plan-time failure beats a
   dashboard that works from one of its configured hostnames.
4. The root stack passed one `db_deletion_protection` to both RDS *and* the Cognito pool, so
   disabling it to tear down a database also unprotected the user pool. Now
   `cognito_deletion_protection`.
5. The RDS free-storage alarm derived its threshold from `var.db_allocated_storage` while
   autoscaling is enabled, so a grown volume would make a stated 20% threshold effectively
   4%. Now reads `module.database.allocated_storage`.

Open, with the reasoning recorded so the next session need not rediscover it:
- `modules/database` sets `prevent_destroy = false`. Deliberate — `prevent_destroy` cannot
  be driven by a variable, so `true` would force anyone tearing down a staging stack to edit
  a shared module. `deletion_protection` (default true) is the guard instead, and being
  enforced by RDS it also blocks a console or CLI deletion. The misleading comment is fixed;
  the value is intentional.
- `final_snapshot_identifier` in `modules/database` is a fixed name, so a second teardown of
  the same environment collides with the snapshot left by the first. Worth suffixing with a
  timestamp.

---

## 8. Config and secret placeholders the deployer must still fill

| Where | What | Consequence of leaving it |
|---|---|---|
| `infra/terraform.tfvars` | `alarm_email` | Alarms publish to a topic with no subscriber. A failed nightly aggregation silently produces no timesheets. |
| `infra/terraform.tfvars` | `dashboard_origins` | Defaults to `http://localhost:3000`. A permitted localhost origin in production is a usable target. |
| `CODE_OF_CONDUCT.md` | `CONDUCT_CONTACT_PLACEHOLDER` | Both files document a working fallback (GitHub private security advisory) in the meantime. |
| `SECURITY.md` | `SECURITY_CONTACT_PLACEHOLDER` | As above. |
| README badge, issue templates, CHANGELOG links | `github.com/worklens/worklens` is a stand-in slug | Links 404 until replaced with the real owner/repo. |
| `backend/.env` | Generated by `make env-backend` after apply | — |
| `dashboard/.env.local` | Generated by `make env-dashboard` after apply | — |

No real secret is in the repo. The device root key is generated by Terraform into Secrets
Manager; the database password is managed by RDS and never enters Terraform state.

---

## 9. The exact next instruction

> Continue Phase 2 of the WorkLens build in `/Users/devakrkunthuri/worklens`. Read
> `docs/RESUME.md`, then `docs/PLAN.md` §2 and §4, then every file in
> `backend/src/shared/` and `backend/src/middleware/deviceAuth.ts`.
>
> Confirm the baseline first: `cd backend && npx tsc --noEmit && npx eslint . --max-warnings 0
> && npx vitest run` should give 182 passing tests and no errors, and `make check-functions`
> should report 14 functions on both sides.
>
> Then finish Phase 2 — two files: `src/handlers/jobs/dbMigrate.ts` (factor the ledger and checksum
> logic out of `backend/scripts/migrate.ts` into `src/shared/migrations/` so the CLI and the
> Lambda share one implementation) and `src/handlers/auth/preTokenGeneration.ts`. Phase 2 is
> done when `make backend-build` produces all 14 zips and all three checks are clean. Note
> that `make backend-build` currently stops at `admin-api`, whose dashboard handler is a
> Phase 4/5 file — so the last two Phase 2 handlers unblock the device and job functions,
> not the whole build.
>
> Do not reintroduce a `device-authorizer` Lambda: a REST API Lambda authorizer is not given
> the request body, and the signature covers a hash of the body. Do not add a column to the
> schema that is not already there — `backend/migrations/0001_init.sql` is authoritative,
> and a new column is a new forward-only migration.
