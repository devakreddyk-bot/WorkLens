# RESUME — WorkLens build state

**Written:** 2026-08-20 · **Repo:** `/Users/devakrkunthuri/worklens` (git, branch `main`)
**Phases complete:** 0, 1, 2, 3, 4 and 5. **Phase 6 (hardening) is next**, then Phase 7 (docs
and release).

**State at this checkpoint:** 427 backend tests and 13 agent packages pass, both Windows
binaries build, the dashboard's `tsc` / `eslint --max-warnings 0` / `next build` are clean,
`terraform validate` is clean, and all six compliance gates pass. Nothing is half-written.

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
  .github/workflows/ci.yml  .github/dependabot.yml  + templates

  scripts/check-privacy.sh      forbidden capture APIs
  scripts/check-iam.sh          unjustified IAM wildcards
  scripts/check-readme.sh       responsible-use section present and complete
  scripts/check-functions.sh    functions.json vs the Terraform catalogue
  scripts/check-migrations.sh   every migration bundled into db-migrate
  scripts/check-routes.sh       dashboard calls vs the backend route tables
  scripts/privacy-allowlist.txt (empty by design)

  contracts/signature-vectors.json   8 HMAC vectors, asserted from Go AND TypeScript

  docs/  MASTER_BUILD_PROMPT.md  PLAN.md  ARCHITECTURE.md  AGENT.md
         SECURITY.md  RESPONSIBLE_USE.md  RESUME.md (this file)

  agent/         Go, Windows. cmd/{worklens-agent,worklens-agentctl}
                 internal/{capture,config,logging,notice,platform,privacy,
                           screenshot,signing,store,supervisor,tray,uploader}
                 13 test-reporting packages, all passing under -race
  backend/       TypeScript. migrations/ (3), src/{shared,middleware,repositories,
                 schemas,handlers,aggregation}, 17 test files / 427 tests
  dashboard/     Next.js 15 App Router. 19 routes, src/{app,components,lib}
  infra/         Terraform. bootstrap/ + 10 modules (plus the nested
                 lambda/modules/function), each with its own README
  bin/           built agent binaries (gitignored)
```

Still to be written: `docs/{API,DEPLOYMENT,CONFIGURATION,OPERATIONS}.md` (Phase 7).

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

### Phase 2 — complete, committed as `85a9736`, `98f31f7` and `d73b163`

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

### Phase 3 — complete, committed as `d219049`…`337d062`

The Windows agent. 13 packages, `go test ./... -race` clean, both binaries cross-compile
with `CGO_ENABLED=0`.

- `internal/signing` matched all 8 shared contract vectors on its first run. The guard was
  then proved to bite by mutating the Go implementation and watching the vectors fail.
- `internal/privacy/rules.go` applies **every** privacy rule locally, before anything is
  queued for upload: work-hours windows, excluded apps, excluded URL patterns, blur. An
  empty `WorkDays` fails closed (collects nothing) rather than open. `isoWeekday` is the
  only place Go's and ISO's weekday conventions meet, deliberately isolated.
- `internal/store` is a claim protocol — `AppendEvent` / `ClaimBatch` / `DeleteBatch` /
  `ReleaseBatch` / `Recover` — so a crash mid-upload cannot lose or duplicate a batch.
- `internal/uploader/pinning.go` pins to the four Amazon **root** CAs, not a leaf.
- `internal/tray` is the visibility guarantee: `Require()` returns a controller *alongside*
  any error, never instead of one, so no code path can start collecting with no tray icon.
- `cmd/worklens-agentctl/install.go` writes the logon Scheduled Task XML (D5: a session-0
  service cannot see the interactive desktop).

### Phase 4 — complete, committed as `d5875e1`…`e577373`

Aggregation and the dashboard/admin APIs.

- `src/aggregation/rollup.ts` is a **pure** function — no clock, no database — which is what
  makes DST, 23- and 25-hour days, and midnight-straddling sessions testable.
- `src/aggregation/zone.ts` does timezone arithmetic through `Intl` with no library;
  `startOfLocalDay` is two-pass because the first pass can land on the wrong side of a DST
  transition.
- `EVENT_LOOKBEHIND_MS` is 61 minutes so an event straddling a day boundary is not missed,
  while only days inside the requested range are written.
- `retentionSweeper` deletes S3 objects **before** rows, so a failure leaves an orphan row
  (recoverable) rather than an orphan object (invisible, and still holding an image).
- A user-supplied URL rule pattern took **95 seconds** on a catastrophic backtrack. JS
  cannot interrupt a running regex, so a time budget was near-useless; `NESTED_QUANTIFIER_RE`
  now refuses dangerous patterns at compile time. 95s → 24ms.

### Phase 5 — complete, committed as `5656421`, `3d4e56f`, `640a244` and `32945d8`

The dashboard: 19 routes, Cognito authorization-code + PKCE, `httpOnly` cookie sessions,
server-side admin MFA gate (D7), and `docs/{SECURITY,RESPONSIBLE_USE}.md`.

- The design is "a register, not a console": ledger-green banding, flat (`* { border-radius:
  0 }`), no dark mode. `src/app/globals.css` carries the full rationale.
- `src/components/DayBand.tsx` is the signature element — a real 24-hour axis with the gaps
  left as paper, because a percentage hides *when* somebody worked. It uses `Intl`, not
  `getHours()`, so a Melbourne manager sees an Indian employee's 09:00 at 09:00.
- **`/me` renders the same `EmployeeRecord` with the same props as `/employees/[id]`.** Not a
  reduced view. Verified, not assumed.
- **A screenshot's presigned URL is fetched on click**, one image at a time. Issuing a URL
  writes an access to the audit log, so an unviewed image must not appear there as viewed —
  and the URLs expire in 300s, so presigning a gallery up front breaks it anyway.
- `src/lib/session.ts` names its decoder `decodeUnverifiedPayload` to make the omission
  unmissable: the cookie payload is read without verification because the **server** is what
  authorizes every request. The UI reflects the server's decision, it does not make one.

---

## 5. What is IN PROGRESS
**Nothing.** No half-written file, no background agent running, no failing test.

The last piece of delegated work (the dashboard pages) was audited before it was committed
rather than taken on trust, which is how the `api.ts` defect in §7 was found.

---

## 6. What is NEXT, in order
**Phase 6 — hardening.** The security-checklist pass is done and written up in
`docs/SECURITY.md`, including, deliberately, what is *not* defended (AWS itself, a
compromised laptop, a malicious deployer, traffic analysis) and what is *unverified*
(nothing has been deployed; IAM has never been exercised; the WAF has never seen traffic;
the Windows syscall layer has never run on Windows; there has been no pen test). Remaining:

1. Fill the test gaps. The thinnest areas are the dashboard's server actions and
   `src/lib/dates.ts`; `internal/capture` is tested at the boundary but its Win32 layer
   cannot be tested off-Windows and should be stated as such rather than mocked into a
   false green.
2. Confirm CI is green on all four toolchains (Go, backend TS, dashboard TS, Terraform) —
   it has never run on a pushed branch, only locally via `make ci`.

**Phase 7 — documentation and release.** `README.md` in full, then
`docs/{DEPLOYMENT,CONFIGURATION,OPERATIONS,API}.md`, then tag `v0.1.0`. This is the
author's first public repository, so the responsible-use posture and the honesty of
`docs/SECURITY.md` matter as much as the code.

**Known follow-ups, none blocking:**
- CSV export returns a base64 JSON envelope because `backend/src/shared/http.ts` serialises
  every body with `JSON.stringify`. A real `text/csv` response needs a raw-response branch
  in its `toProxyResult`. The client reassembles the bytes so the BOM and CRLF endings stay
  exact; it is a wart, not a bug.
- No rule-preview endpoint: an admin cannot see what a project rule would match before
  saving it.
- No PDF export.
- `final_snapshot_identifier` in `modules/database` is a fixed name, so a second teardown of
  the same environment collides with the first one's snapshot.

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

**The dashboard hand-declares its API types, and `scripts/check-routes.sh` is what keeps
that honest.** `dashboard/src/lib/api.ts` does not import the backend's Zod schemas, because
the two tiers deploy separately and a dashboard build should not be coupled to a backend
source tree it may not be released alongside. That reasoning stands. What it cost: the
declarations are a copy, and the first version of them was written from `docs/PLAN.md`
instead of from the handlers, so it called `/timesheets/team` and a `/breakdown` sub-route,
neither of which exists (the team register is a projection of `/overview`; the breakdown is
an `include_breakdown` flag). `tsc` cannot catch this — each tier is internally consistent,
which is precisely what the separation buys — so the gate compares called paths and methods
against the backend's route tables. It does **not** check field names. If you change a shape
in `api.ts`, read the handler.

Two lessons worth keeping. First: when work is delegated, audit it before trusting it — this
defect was found because the delegated agent's claim that it had corrected existing code was
checked rather than accepted, and the claim was right. Second: a gate is not trustworthy
until it has been proved to bite. This one's first run reported a `POST /devices` that does
not exist, because it looked for the HTTP method in a fixed window after the path and picked
up the *next* helper's `POST`. A gate that cries wolf gets switched off.

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
> Continue the WorkLens build in `/Users/devakrkunthuri/worklens` at **Phase 6
> (hardening)**, then Phase 7. Phases 0–5 are complete and committed.
>
> Read `docs/RESUME.md` first, then `docs/SECURITY.md` — its "what is unverified" section is
> the honest inventory of what Phase 6 has to either close or state plainly.
>
> Confirm the baseline before changing anything:
> ```
> cd backend && npx vitest run                    # 427 tests, 17 files
> cd ../agent && go test ./... -race              # 13 packages
> cd ../dashboard && npx tsc --noEmit && npx eslint . --max-warnings 0 && npm run build
> cd .. && make check-privacy check-iam check-readme check-functions check-migrations check-routes
> ```
>
> Phase 6, in order:
>
> 1. **Fill the test gaps**, thinnest first: the dashboard's server actions
>    (`src/lib/actions.ts`) and `src/lib/dates.ts`. Prefer tests that would have caught a real
>    defect over tests that raise a coverage number.
> 2. **Do not mock the agent's Win32 layer into a false green.** It cannot run off-Windows.
>    State that as a known limit — `docs/AGENT.md` §10 already does — rather than pretending.
> 3. **Get CI green on a pushed branch.** `make ci` passes locally but the workflow has never
>    actually run; expect the usual first-run problems (toolchain versions, working
>    directories, cache keys).
>
> Then Phase 7: `README.md` in full, `docs/{DEPLOYMENT,CONFIGURATION,OPERATIONS,API}.md`,
> `CHANGELOG.md`, tag `v0.1.0`.
>
> Standing constraints that outrank convenience, from `docs/MASTER_BUILD_PROMPT.md`:
> **no keystroke content, no password, webcam, microphone or clipboard capture; the agent stays
> visible (tray icon, first-run notice) and cannot be made covert; privacy rules are applied on
> the device before upload; no secret in the repo, in a comment, or in a chat message.** No
> placeholders or `TODO`s in shipped code — a value the deployer must supply belongs in
> `.env.example` with a comment saying so.
>
> If a delegated agent reports that it changed existing code, verify the claim before
> accepting it, and say plainly in the commit message when the pre-existing code was wrong.
