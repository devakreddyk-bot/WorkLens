# API reference

Every route WorkLens exposes, what authorises it, and what it returns.

This document is derived from the code rather than from the design: the route tables in
`infra/modules/api/main.tf` (what is reachable), the routers in `backend/src/handlers/` (what
answers, and under which policy), and the schemas in `backend/src/schemas/` (what is accepted).
Where any of those disagree with `docs/PLAN.md`, they win — they are the thing that will actually
run. `scripts/check-routes.sh` enforces that the three lists agree, in CI, for the reason described
in §9.

**Nothing here has been exercised against a deployed API.** The request and response shapes are read
off the handlers and their tests; no AWS account has served one of these calls. `docs/SECURITY.md` §4
lists what else is unverified.

---

## 1. Base URL and versioning

```
https://<api-id>.execute-api.<region>.amazonaws.com/v1
```

The stage name is the first path segment and is a Terraform variable (`stage_name`, default `v1`).
Every path below is relative to that base, so `/device/events` is `POST /v1/device/events`.

There is one API and two entirely separate authentication schemes on it: agents sign requests with a
device secret, and the dashboard presents a Cognito token. Neither can be used in place of the other.

---

## 2. Authentication, and why that is not authorisation

### 2.1 Agent requests: HMAC over a canonical request

Seven `/device/*` routes are authenticated by signature. There is no bearer token: a captured token
is replayable for its lifetime, and an agent runs unattended on a laptop the deployer does not fully
control.

Four headers:

| Header | Value |
|---|---|
| `X-WL-Device` | the device UUID returned by enrolment |
| `X-WL-Timestamp` | Unix seconds |
| `X-WL-Nonce` | 32 hex characters — 128 bits from a CSPRNG |
| `X-WL-Signature` | 64 hex characters — HMAC-SHA256 of the canonical request |

The canonical request is:

```
METHOD \n PATH \n TIMESTAMP \n NONCE \n hex(sha256(BODY))
```

Each element is load-bearing. `METHOD` and `PATH` stop a signature captured from one endpoint being
replayed against another — without them a signed `GET /v1/device/config` could be replayed as
`POST /v1/device/events` with the same empty body. `TIMESTAMP` bounds the replay window to the
accepted skew (`HMAC_TIMESTAMP_SKEW_SECONDS`, default 300). `NONCE` closes that window entirely: a
nonce is accepted once and remembered for longer than a timestamp stays valid, which is why
configuration validation refuses a `NONCE_RETENTION_SECONDS` that is not greater than the skew. The
body hash makes the payload tamper-evident.

The timestamp is checked **before** the signature, so a device with a wrong clock gets
`TIMESTAMP_OUT_OF_WINDOW` and can diagnose it, rather than an indistinguishable
`INVALID_SIGNATURE`.

The device secret is never stored server-side. It is derived on demand as
`base64url(HMAC-SHA256(root_key[v], "v<v>:<org>:<device>"))`, so a database disclosure yields no
device credential. `contracts/signature-vectors.json` pins the scheme with eight vectors asserted
from both the Go agent and the TypeScript backend; see `docs/SECURITY.md` §2.1 and §2.5.

### 2.2 Dashboard requests: a Cognito ID token

Thirty routes are authenticated by API Gateway's Cognito authorizer. The dashboard holds tokens in
`httpOnly` cookies and calls the API from a Server Component or Server Action, so a token never
reaches client JavaScript (`docs/SECURITY.md` §2.9).

The pre-token-generation trigger puts the caller's context into the token as custom claims:

| Claim | Meaning |
|---|---|
| `wl:org` | organisation id — every query is scoped to it |
| `wl:user` | `users.id` |
| `wl:role` | `owner`, `manager` or `employee` |
| `wl:employee` | `employees.id`, or empty for an admin-only account with no monitored machine |
| `wl:mfa` | `on` when a second factor is configured |
| `wl:tz` | the organisation's IANA timezone |

### 2.3 Authorisation is the POLICY table, and only the POLICY table

**A valid token establishes who is calling. It never establishes what they may do.** That decision
is made in one place — `POLICY` in `backend/src/middleware/cognitoAuth.ts` — applied by the router
inside each handler Lambda:

| Policy | Roles | MFA-gated | Used for |
|---|---|---|---|
| `self` | owner, manager, employee | no | `/me` |
| `adminRead` | owner, manager | yes | organisation-wide reads |
| `employeeRead` | owner, manager, employee | no (see below) | a single employee's data |
| `ownerWrite` | owner | yes | settings, users, devices, projects, erasure |

`employeeRead` is not MFA-gated because an employee reading their own record must not be, and
`resolveEmployeeScope` refuses any subject other than self for an employee caller.
`assertAdminMfaForSubject` re-applies the MFA requirement the moment an admin asks for somebody
else's data — so the gate lands on admin access, not on a person reading their own timesheet.

The corollary matters more than the table: a route whose target Lambda has no entry in a handler
router has been authenticated and **not** authorised. That is not hypothetical — `POST
/aggregation/run` was such a route and is documented in `docs/SECURITY.md` §2.3.1. It is why
`scripts/check-routes.sh` compares the gateway's route map against the routers in both directions.

---

## 3. Errors

Every failure has the same envelope:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Written for a person to read.",
    "details": [{ "field": "screenshot_interval_seconds", "message": "must be at least 60" }],
    "requestId": "abc123"
  }
}
```

`details` is present only when the failure names specific fields, and `field` within it is optional —
a complaint about the request as a whole has no input to sit beside. `requestId` is the same id in
the API's access log and application log, which is the one thing support can act on.

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 400 | The request did not match the schema. `details` names the fields. |
| `MALFORMED_JSON` | 400 | The body was not JSON. |
| `BATCH_TOO_LARGE` | 400 | More than `MAX_EVENTS_PER_BATCH` (default 500) events. |
| `PAYLOAD_TOO_LARGE` | 413 | The body exceeded the accepted size. |
| `MISSING_CREDENTIALS` | 401 | A signing header is absent. |
| `INVALID_SIGNATURE` | 401 | The HMAC did not verify. |
| `TIMESTAMP_OUT_OF_WINDOW` | 401 | Clock skew beyond `HMAC_TIMESTAMP_SKEW_SECONDS`. |
| `REPLAYED_REQUEST` | 401 | The nonce has been seen before. |
| `INVALID_TOKEN` | 401 | The enrolment token is not recognised. |
| `DEVICE_REVOKED` | 403 | The device has been revoked. Stop uploading. |
| `FORBIDDEN` | 403 | The role may not do this, or the subject is not the caller's. |
| `MFA_REQUIRED` | 403 | An admin route reached without a second factor. |
| `FEATURE_DISABLED` | 403 | The organisation's configuration switches this off — e.g. screenshots. |
| `NOT_FOUND` | 404 | No such resource in the caller's organisation. |
| `ENROLLMENT_TOKEN_USED` | 409 | Already redeemed. |
| `ENROLLMENT_TOKEN_EXPIRED` | 410 | Past its expiry. |
| `CONFLICT` | 409 | The write contradicts current state. |
| `QUOTA_EXCEEDED` | 429 | The device's ingest quota for the window is spent. |
| `INTERNAL_ERROR` | 500 | Unexpected. The `requestId` is in the logs. |
| `SERVICE_UNAVAILABLE` | 503 | A dependency is unavailable. Retry with backoff. |

`MFA_REQUIRED` is worth handling specifically: the dashboard turns it into a redirect to
`/mfa-required`, which is why `GET /me` is deliberately not MFA-gated — an admin without a second
factor needs a page they can actually reach in order to enrol.

---

## 4. Device API

Seven routes, all HMAC-signed except enrolment.

### `POST /device/enroll`

Unauthenticated — this is where a device gets its credential. The body carries a one-time enrolment
token issued by an owner (`POST /devices/enrollment-tokens`), plus the machine's identifying
details. The response carries the device id and the derived secret; **the secret is returned once
and never stored server-side**, so an agent that loses it must re-enrol.

Enrolment inserts the device *before* marking the token used, because
`enrollment_tokens_used_chk` and the foreign key on `used_by_device_id` require that order. Two
agents racing the same token: the loser's `UPDATE ... WHERE used_at IS NULL` matches no row and the
transaction aborts, discarding its device row.

### `GET /device/config`

The organisation's monitoring configuration. The agent applies **every** rule in it locally, before
anything is queued for upload — work-hours windows, excluded applications, excluded URL patterns,
screenshot blur. Data outside the configured window is never collected, not collected and filtered
server-side (`docs/AGENT.md`).

### `POST /device/events`

A batch of activity events. Idempotent on `idempotency_key` — 16–128 characters of
`[A-Za-z0-9_.:-]`, which the agent derives as the SHA-256 of the sorted `client_event_id` list. The
key is opaque to the server, so a future agent can change how it derives one without a backend
deploy.

Event types: `window_sample`, `idle_state`, `session_start`, `session_end`, `notice_ack`,
`agent_health`.

Constraints worth knowing before writing a client:

- **An idle event may not carry attribution.** `app_name`, `app_exe`, `window_title`, `url_host` and
  `url_title` are rejected on an `idle_state` event, and the database enforces the same thing with
  `activity_events_idle_no_attribution_chk`. Idle means "no input was detected"; it must not also
  record what was on screen.
- **`duration_seconds` is 0–3600.** The hour cap is a real defence: a laptop resumed from sleep, or
  one whose clock moved, can otherwise report a single event spanning days.
- **`category` and `project_id` are rejected**, though the columns exist. They are derived
  server-side at aggregation from `app_categories` and `project_rules`; accepting them would let a
  tampered agent label its own time.
- **A `client_event_id` repeated within one batch is an error**, not a silently absorbed duplicate.
  Absorbing it would make the accepted/duplicate counts useless as a signal that the agent's local
  buffer is misbehaving.
- **The quota is charged for rejected batches too.** Otherwise hammering the endpoint would be free.

### `POST /device/screenshots` and `POST /device/screenshots/{id}/complete`

Two steps. The first returns a presigned S3 `PUT` constrained to the declared content type and byte
count; the agent uploads directly to S3, then calls the second to record that the object exists.
Nothing about a screenshot is trusted until the completion call, so an abandoned upload leaves no row
claiming an image that is not there.

The presign names `content-type` in `signableHeaders` deliberately — it sits in the AWS presigner's
default `unsignableHeaders`, and unsigned it would not constrain what gets uploaded, which is the
entire point of a constrained presign.

### `POST /device/heartbeat`

Liveness plus agent health counters. The counters are **logged, not stored**: `devices` has no column
for buffer depth or dropped events, and adding one is a schema decision rather than a handler's call.

### `POST /device/notice-ack`

Records that the employee acknowledged the first-run notice. **Takes no body.** A client-supplied
timestamp is self-reported, and this column is the deployer's evidence that a person was informed.
Idempotent via `coalesce(notice_acknowledged_at, now())` with a CTE reporting the pre-update value,
so the audit row is written exactly once however many times it is called.

---

## 5. Dashboard API — reading

| Route | Policy |
|---|---|
| `GET /me` | `self` |
| `GET /overview` | `adminRead` |
| `GET /employees` | `adminRead` |
| `GET /timesheets` | `adminRead` |
| `GET /employees/{id}/timesheets` | `employeeRead` |
| `GET /employees/{id}/activity` | `employeeRead` |
| `GET /employees/{id}/screenshots` | `employeeRead` |
| `GET /employees/{id}/screenshots/{sid}/url` | `employeeRead` |
| `GET /reports/export` | `adminRead` |

### `GET /me`

The caller's own context: `{user, organization, employee, mfa}`. `employee` is null for an
admin-only account — a bookkeeper with no monitored machine — and the dashboard has to say so rather
than render an empty day. Not MFA-gated, deliberately (§3).

### `GET /overview?date=YYYY-MM-DD`

The organisation's day. `date` defaults to today **in the organisation's timezone**, resolved by the
handler rather than the caller. This is also where the team register comes from: there is no
`/timesheets/team` route.

### `GET /timesheets?from&to&employee_id&limit`

A range across the organisation, or one employee with `employee_id`. `limit` defaults to 500, max
2000. A range may not exceed `MAX_RANGE_DAYS` (400).

### `GET /employees/{id}/timesheets?from&to&include_breakdown`

One employee's range. `include_breakdown=true` adds the per-app, per-site, per-category and
per-project child totals — four extra reads, which is why it is off by default and why a 400-day
range does not want them. There is no separate `/breakdown` route.

### `GET /employees/{id}/activity?date&cursor&limit`

Individual recorded spans for one employee-day. `date` is **required**, so the scan is always bounded
to a single employee-day. `limit` defaults to 200, max 500. Cursor-paginated.

### `GET /employees/{id}/screenshots?date&cursor&limit`

Screenshot metadata for a day — not the images. `limit` defaults to 60, max 200.

### `GET /employees/{id}/screenshots/{sid}/url`

One presigned view URL, valid for `PRESIGN_VIEW_EXPIRY_SECONDS` (default 300). That is deliberately
shorter than the upload TTL: a view URL is handed to a browser, an upload URL is used immediately by
the agent. Issuing it
**writes an access to the audit log**, which is why it is one call per image rather than a batch: the
dashboard fetches on click, so an image nobody opened does not appear in the trail as viewed.

### `GET /reports/export?format=csv&from&to&employee_id`

The payroll CSV. Two things to know:

- **`format=pdf` is rejected with a 400 that says why.** PDF was planned as a client-side render;
  it is not implemented in any tier. The 400 is deliberate — a caller learns the answer rather than
  guessing from a 501 whether it is coming.
- **The response is a real `text/csv` download**, with `Content-Disposition: attachment` and a
  filename derived from the range and the employee scope. It begins with a UTF-8 byte-order mark and
  uses CRLF line endings, which is what Excel needs to open it without mangling an accented name.

  It used to be base64 inside a JSON envelope, because `backend/src/shared/http.ts` serialised every
  body with `JSON.stringify`. That wrapper now has a raw branch (`raw` and `attachment`), so a client
  other than this dashboard gets a spreadsheet when it asks for one, and `Content-Type` no longer
  claims `application/json` for a file that is not. The security headers still apply — the raw branch
  overrides exactly one of them.

The CSV itself is generated over keyset-paginated pages, so the Lambda holds one page and one 64 KB
chunk regardless of how long the range is.

---

## 6. Dashboard API — administration

All `ownerWrite`: owner role, MFA required.

| Route | Purpose |
|---|---|
| `POST /employees` · `PATCH /employees/{id}` | The monitored people. |
| `GET`/`POST` `/users` · `PATCH /users/{id}` | Dashboard accounts and roles. |
| `GET`/`POST` `/projects` · `PATCH`/`DELETE` `/projects/{id}` | Projects for time attribution. |
| `GET`/`POST` `/projects/{id}/rules` · `DELETE /projects/{id}/rules/{rid}` | The matching rules. |
| `GET`/`PUT` `/config` | The organisation's monitoring configuration. |
| `GET /devices` · `POST /devices/enrollment-tokens` · `POST /devices/{id}/revoke` | Device lifecycle. |
| `GET /audit-log` | Every access to employee data. |
| `GET`/`POST` `/deletion-requests` · `POST /deletion-requests/{id}/execute` | Erasure, in two steps. |

Three of these deserve expanding.

**`PUT /config`** is the privacy surface. Its schema and the `monitoring_config` CHECK constraints
enforce the invariants together, so an invalid configuration cannot be stored even if a schema check
were bypassed — most importantly `monitoring_config_retention_chk`, which refuses a configuration
where screenshots would outlive the events they belong to. Defaults are the least-invasive value that
still produces a defensible timesheet; see `docs/CONFIGURATION.md`.

**Erasure is two calls, not one.** `POST /deletion-requests` records the request;
`POST /deletion-requests/{id}/execute` performs it. The separation is the point: an irreversible
deletion should be a distinct, audited act rather than a side effect of a form submission. Execution
deletes S3 objects **before** rows, so a failure leaves a recoverable orphan row rather than an
invisible orphan object still holding an image (`docs/SECURITY.md` §2.4).

**There is no rule-preview endpoint.** An owner cannot ask what a project rule *would* match before
saving it. That is a known gap, recorded here rather than left to be discovered.

---

## 7. Pagination

Cursor-based, on `/employees/{id}/activity`, `/employees/{id}/screenshots` and `/audit-log`. Pass the
`cursor` from the previous response; its absence means the end. Cursors are opaque — do not construct
or parse one. Offset pagination is not offered: on an append-only event table it silently skips or
repeats rows as new data arrives underneath the reader.

---

## 8. Quotas and limits

| Limit | Default | Set by |
|---|---|---|
| Events per batch | 500 | `MAX_EVENTS_PER_BATCH` (1–5000) |
| Device ingest quota | 5000 events / 3600s | `DEVICE_QUOTA_EVENTS_PER_WINDOW`, `DEVICE_QUOTA_WINDOW_SECONDS` |
| Signing clock skew | 300s | `HMAC_TIMESTAMP_SKEW_SECONDS` (30–900) |
| Event duration | 3600s | fixed in the schema |
| Query range | 400 days | `MAX_RANGE_DAYS` |
| Presigned view URL life | 300s | `PRESIGN_VIEW_EXPIRY_SECONDS` |
| Integration timeout | 29s | API Gateway, per route |

A batch's size is checked **before** the schema runs over it. Validating first would mean executing
a per-event refinement over an array whose length a hostile or broken client chose, which is work the
request has not earned.

WAF rules sit in front of all of this; see `infra/modules/waf/`.

---

## 9. What keeps this document true

Three hand-maintained route lists have to agree: the gateway's map in `infra/modules/api/main.tf`,
the routers in `backend/src/handlers/`, and the dashboard's client in `dashboard/src/lib/api.ts`.
Nothing in the type system can check that — each tier is internally consistent, which is exactly what
deploying them separately buys — so `scripts/check-routes.sh` does it in CI, in both directions.

Both halves of that gate exist because both drifted. The dashboard client was written from the design
document rather than the handlers and called two routes that do not exist. The gateway exposed a
route with no router entry behind it, and therefore no authorisation. Neither was caught by
`tsc`, by `terraform validate`, or by any test.

---

## 10. What this API does not do

- **No keystroke content, ever.** There is no field for it, no column for it, and
  `scripts/check-privacy.sh` fails the build on a reference to one. Idle detection uses
  `GetLastInputInfo`, which returns a timestamp and nothing else.
- **No password, webcam, microphone or clipboard capture.** Same enforcement.
- **No client-supplied categorisation.** `category` and `project_id` are derived server-side.
- **No cross-organisation read of any kind.** Every query is scoped to `wl:org` from the token.
- **No PDF export**, and no rule-preview endpoint. Both are stated rather than implied.
