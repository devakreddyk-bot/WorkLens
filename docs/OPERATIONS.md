# Operations

This is the document to read when something is wrong, or when a routine duty comes due. It is
organised by *what you are trying to do*, not by component, because the thing an operator has when
they open this is a symptom — an alarm email, a complaint that a timesheet is missing, a deletion
request from an employee — rather than a subsystem.

Everything here is derived from the code and the Terraform in this repository. Alarm names, cron
expressions, thresholds and retention periods are quoted from the resource that defines them, and
the file is named each time so you can check rather than trust.

## Nothing here has been run against real infrastructure

**No AWS account has ever run this stack.** No alarm has fired, no scheduled job has executed, no
runbook step below has been performed against a deployed system. `docs/SECURITY.md` §4 says the same
thing about the security claims, and the honesty register is the same here: every procedure is
derived from reading the code that would handle it, and none is derived from having watched it work.

Concretely, that means:

- The AWS CLI commands are correct as far as the API shapes go, but none has been executed against
  this stack. Expect to adjust flags for your CLI version.
- The failure modes described are the ones the code is written to produce. A real deployment will
  produce some that nobody anticipated.
- Timings — how long a sweep takes, whether a 300-second aggregation timeout is enough at 50
  devices — are estimates from the code's bounds, not measurements.
- §14 lists five defects found *while writing this document*, by reading the code paths a runbook
  has to describe. One of them stops device enrolment working at all on a first deploy. They are
  recorded here rather than quietly fixed because this is a documentation phase, and because the
  fact that writing the runbook found them is itself the useful information.

Treat the first month of a real deployment as the period in which this document gets corrected.

---

## 1. Names and identifiers

Everything is named `<project>-<environment>-<thing>`, from `local.name_prefix` in
`infra/main.tf`. With the defaults (`project = "worklens"`, `environment = "prod"`,
`aws_region = "ap-south-1"`) that gives:

| Thing | Name |
|---|---|
| Lambda functions | `worklens-prod-<key>`, keys from `backend/functions.json` |
| Lambda log groups | `/aws/lambda/worklens-prod-<key>` |
| API Gateway access log | `/aws/apigateway/worklens-prod/access` |
| API Gateway execution log | `API-Gateway-Execution-Logs_<api-id>/v1` |
| PostgreSQL log | `/aws/rds/instance/worklens-prod-pg/postgresql` |
| RDS instance | `worklens-prod-pg` |
| DB subnet group / parameter group | `worklens-prod-db` / `worklens-prod-pg16` |
| Alarm SNS topic | `worklens-prod-alarms` |
| Schedule dead-letter queue | `worklens-prod-schedule-dlq` |
| EventBridge rules | `worklens-prod-aggregate-timesheets`, `-retention-sweeper`, `-nonce-sweeper` |
| Device root key secret | `worklens-prod/device-root-key` |
| Final DB snapshot (on destroy) | `worklens-prod-pg-final` |

The stack prints most of what you need after an apply. Get it back at any time:

```bash
terraform -chdir=infra output
```

```bash
terraform -chdir=infra output alarm_names
```

```bash
terraform -chdir=infra output -raw schedule_dead_letter_queue_url
```

**A note on `aws lambda invoke`.** AWS CLI v2 base64-decodes `--payload` by default, so every
invoke below includes `--cli-binary-format raw-in-base64-out`. Without it you get an
`Invalid base64` error that looks like a permissions problem. The `next_steps` output in
`infra/outputs.tf` omits the flag — see §14.

---

## 2. Routine duties

### Daily

1. **Check that timesheets exist for yesterday.** Open the dashboard's team view for yesterday's
   date. This is the only check that covers the whole pipeline end to end: an agent that stopped
   capturing, an ingest that started failing, and an aggregation that did not run all present as
   the same missing row, and §7 separates them.
2. **Check the alarm inbox.** Both `ALARM` and `OK` transitions are published
   (`alarm_actions` and `ok_actions` are set on every alarm in `infra/modules/alarms/main.tf`), so
   an alarm you were paged for at 02:00 will have sent its own recovery notice.
3. **Check the dead-letter queue is empty** if the DLQ alarm is not wired to a subscriber yet:

```bash
aws sqs get-queue-attributes --region ap-south-1 --queue-url "$(terraform -chdir=infra output -raw schedule_dead_letter_queue_url)" --attribute-names ApproximateNumberOfMessages
```

### Weekly

1. **Look at device liveness.** Settings → Devices shows `last_seen_at` per device, written by the
   heartbeat handler (`backend/src/repositories/devices.ts`). A device with no heartbeat for
   several days is either a laptop that has been off, an agent that has stopped, or an employee
   who has left. The first two are indistinguishable from here — §7.1 is the diagnosis.
2. **Read the audit log.** `GET /v1/audit-log`, or the dashboard's Audit Log page. Reading it is
   itself audited, deliberately. What you are looking for is access that does not match a reason
   you know about — an export nobody asked for, screenshot views outside an investigation.
3. **Check the RDS free-storage headroom** rather than waiting for the alarm, which only gives you
   two five-minute periods of warning below the threshold. Screenshots do not live in the database,
   so growth is `activity_events`, and it is roughly linear in device count.

### Monthly

1. **Confirm the retention sweeper is actually deleting.** Its log line `finished` carries
   `eventsDeleted`, `screenshotsDeleted`, `objectsDeleted` and `moreRemaining`. A `moreRemaining:
   true` that persists across many runs means the per-run ceiling
   (`retention_max_deletions_per_run`, default 200 000) is below the daily accrual and retention is
   permanently behind. See §6.2.
2. **Check the S3 lifecycle backstop still exceeds every configured retention window.**
   `var.screenshot_retention_days` (default 90) expires objects under `screenshots/` regardless of
   what the application thinks. `monitoring_config.retention_days_screenshots` defaults to 30 but
   may be set as high as 3650. If an organisation's window is raised past the backstop, the
   lifecycle rule deletes objects the application still considers live, and the dashboard's presign
   starts failing for screenshots whose rows still exist.
3. **Re-check `npm audit` in `dashboard/`** after any `next` upgrade, against the table in
   `docs/SECURITY.md` §4.1.
4. **Verify the alarm subscription is still confirmed.** An email subscription that was never
   confirmed, or that has been unsubscribed from the footer of an alarm email, shows as an existing
   subscription in Terraform while delivering nothing:

```bash
aws sns list-subscriptions-by-topic --region ap-south-1 --topic-arn "$(terraform -chdir=infra output -raw alarm_topic_arn)"
```

`SubscriptionArn` reads `PendingConfirmation` until somebody clicks the link.

### The duty that has to be done once, before any of this matters

**`alarm_email` defaults to `null`.** `infra/modules/observability/main.tf` creates the
`worklens-prod-alarms` topic unconditionally and creates the email subscription only when
`var.alarm_email` is non-null:

```hcl
resource "aws_sns_topic_subscription" "alarm_email" {
  count = var.alarm_email == null ? 0 : 1
```

With it unset, every alarm in the stack publishes into a topic with no subscribers. Nothing errors.
`terraform apply` succeeds, the alarms exist, the console shows them healthy, and the notification
goes nowhere.

The consequence that matters most is aggregation. **A failed nightly aggregation produces no
timesheets and no user-visible error.** The dashboard shows an employee with no hours, which is
indistinguishable from an employee who did not work. There is no in-application signal — the only
thing that says "the job did not run" is the DLQ alarm and the per-function error alarm, and both
of those go to this topic. Set it:

```hcl
alarm_email = "ops@example.com"
```

Then confirm the email AWS sends. `docs/SECURITY.md` §5 lists this first for the same reason.

---

## 3. The alarms that exist

Seventeen alarms come from `infra/modules/alarms/main.tf` and one from
`infra/modules/scheduling/main.tf`. Every one of them uses a 300-second period; the Lambda error
alarms evaluate a single period and the rest evaluate two, so worst-case detection latency is
around ten minutes. Nothing here catches a fault that resolves inside five minutes.

| Alarm | Metric | Trips when | Missing data |
|---|---|---|---|
| `worklens-prod-lambda-errors-<key>` (one per function) | `AWS/Lambda` `Errors`, Sum | ≥ `lambda_error_threshold` (5) in 5 min | `notBreaching` |
| `worklens-prod-lambda-throttles-ingest-events` | `AWS/Lambda` `Throttles`, Sum | ≥ 1 for 2 consecutive periods | `notBreaching` |
| `worklens-prod-rds-free-storage-low` | `AWS/RDS` `FreeStorageSpace`, Minimum | below `rds_free_storage_threshold_pct` (20 %) of allocated storage for 2 periods | **`breaching`** |
| `worklens-prod-rds-cpu-high` | `AWS/RDS` `CPUUtilization`, Average | above `rds_cpu_threshold_pct` (80 %) for 2 periods | `notBreaching` |
| `worklens-prod-schedule-dlq-not-empty` | `AWS/SQS` `ApproximateNumberOfMessagesVisible`, Maximum | > 0 in 5 min | `notBreaching` |

The `<key>` values are the fourteen function names in `backend/functions.json`:
`admin-api`, `aggregate-timesheets`, `db-migrate`, `device-config`, `enroll`, `heartbeat`,
`ingest-events`, `nonce-sweeper`, `notice-ack`, `pre-token-generation`, `reporting-api`,
`retention-sweeper`, `screenshot-complete`, `screenshot-presign`.

Three things about this set are worth internalising before an alarm arrives.

**The error alarms share one threshold, and the functions are not comparable.** Five errors in five
minutes is noise on `ingest-events` — agents retry, and the buffer means nothing is lost. Five
errors on `pre-token-generation` means five people could not log in. Any error at all on
`db-migrate` matters. The single `lambda_error_threshold` is a compromise recorded as such in
`infra/modules/alarms/README.md`; per-function thresholds would go in that module.

**`treat_missing_data` differs on purpose.** Free storage is `breaching`: if the instance stops
publishing the metric, something is wrong with the database and silence is not reassurance. The
side effect is that stopping the instance, or a long failover, trips the alarm — expect noise
during planned maintenance. Everything else is `notBreaching`, because a Lambda that was not
invoked publishes no `Errors` datapoint and treating that as a breach would leave every low-traffic
function permanently in alarm.

**Ingest gets two alarms for one cause.** It appears in `lambda_function_names` (error alarm) *and*
as `ingest_function_name` (throttle alarm). A capacity incident can page you twice.

### What is not alarmed

Recorded as gaps rather than as decisions, because they are gaps:

- **No alarm on API Gateway 5xx or 4xx rates.** A handler returning 500 to every dashboard request
  raises `Errors` only if it throws; an `AppError` mapped to a 500 by `withHandler` in
  `backend/src/shared/http.ts` is a *successful* invocation as far as Lambda's `Errors` metric is
  concerned. That class of failure is invisible to every alarm in this stack.
- **No alarm on WAF block volume.** A rate-based rule doing its job and a WAF misconfiguration
  blocking every agent look the same from outside.
- **No alarm on CloudTrail delivery failure.** If the trail's bucket policy and the trail name
  diverge (see `infra/modules/observability/README.md`), delivery stops and the failure appears on
  the trail's status page and nowhere else.
- **No alarm on Lambda duration approaching timeout.** Aggregation has a 300-second timeout; a run
  that grows to 280 seconds gives no warning before the first one that fails.

### 3.1 `worklens-prod-lambda-errors-aggregate-timesheets`

**What it means.** The nightly rollup threw. The likely candidates, in the order the code makes
them likely: a database connection failure (RDS failover, connection exhaustion), an invalid
`lookback_days` or date in the event, or `listOrganizationIds` failing before any work started.

Note what this alarm does *not* catch. `backend/src/handlers/jobs/aggregateTimesheets.ts` treats a
per-employee failure as non-fatal — the invocation returns `ok: true` with `employeesFailed > 0`
and logs at `error`:

```
some employees could not be aggregated
```

That is a log line, not a Lambda error, so it does not raise the `Errors` metric and does not trip
this alarm. The reasoning is in the handler: the other employees' timesheets *were* written, and a
retry would repeat the same failure. The operational consequence is that one employee can be
missing timesheets indefinitely with no alarm at all. §7 is how you find that.

**What to do.**

1. Read the log for the failed invocation:

```bash
aws logs tail /aws/lambda/worklens-prod-aggregate-timesheets --region ap-south-1 --since 2h
```

2. If the DLQ alarm also fired, the invocation exhausted its retries and that night's timesheets
   are absent. Recovery is §5.
3. If it did not, EventBridge is still retrying (up to `maximum_retry_attempts` = 3 within
   `maximum_event_age_in_seconds` = 7200) and may succeed without you.
4. **You may not need to do anything.** The next scheduled run recomputes
   `aggregation_lookback_days` (default 3) days, so a single failed night is repaired by the next
   night's run. That is the primary reason the lookback is greater than one.

### 3.2 `worklens-prod-lambda-errors-retention-sweeper`

**What it means.** The sweeper threw before or between organisations. A single organisation's
failure does *not* throw — `retentionSweeper.ts` catches it, records `error` on that org's outcome,
logs `retention failed for one organisation; continuing`, and moves on. So this alarm means
something structural: the `monitoring_config` query failed, or the S3 client could not be
constructed, or `max_deletions_per_run` was below the 1000 floor the handler enforces.

**What this failing costs.** Personal data stays past the window the organisation committed to.
That is a compliance exposure, not an inconvenience, and it is silent — no employee and no
dashboard page shows it.

**What to do.**

1. Read the log. Look for `retention failed for one organisation; continuing` (one org) versus a
   thrown error (all orgs).
2. Re-run it. The sweeper is safe to re-run — see §6.2 — and a dry run tells you the size of the
   backlog first:

```bash
aws lambda invoke --region ap-south-1 --cli-binary-format raw-in-base64-out --function-name worklens-prod-retention-sweeper --payload '{"source":"manual","dry_run":true}' /dev/stdout
```

3. If the failure was S3 permissions or a missing bucket, note that the sweeper deliberately stops
   an organisation when *every* object in a batch fails to delete, rather than looping on rows it
   cannot progress past. The log line is `no screenshot objects could be deleted; stopping this
   organisation`.

### 3.3 `worklens-prod-lambda-errors-ingest-events`

**What it means.** Agents are failing to upload. Five errors in five minutes is a low bar here, so
treat this as informational unless it persists.

**What it costs, and what it does not.** Nothing is lost. Every event goes to the agent's local
SQLite buffer first and is deleted only after a 2xx (`agent/internal/store/store.go`, and
`docs/AGENT.md` §4). The buffer holds 250 MB or 14 days by default. What you lose is *timeliness* —
and if the failure outlasts the buffer cap, the **oldest** events are dropped and an `agent_health`
event records the count, so the resulting gap is explainable rather than mysterious.

**What to do.**

1. Read the log. The structured fields on the failure line name the code
   (`INVALID_SIGNATURE`, `TIMESTAMP_OUT_OF_WINDOW`, `DEVICE_REVOKED`, `QUOTA_EXCEEDED`), which
   distinguishes a fleet-wide problem from one misbehaving laptop.
2. `TIMESTAMP_OUT_OF_WINDOW` from many devices at once means the *server's* view of time is fine
   and something else changed; from one device it means that laptop's clock. `worklens-agentctl
   doctor` on the device compares the local clock against the server's `Date` header and reports
   the skew, precisely so this does not present as an unexplained 401.
3. A 500 from `ingest-events` is usually the database. Check the RDS alarms and the connection
   count before looking at the handler.

### 3.4 `worklens-prod-lambda-throttles-ingest-events`

**What it means.** Not a fault — a capacity signal. `ingest-events` carries
`reserved_concurrent_executions` (`var.ingest_reserved_concurrency`), and this alarm says the
ceiling is being hit, so agents are receiving 429s and backing off.

The reserved concurrency is a **database** protection, not a cost control. Each warm container
holds a Postgres connection (`DB_POOL_MAX` is 1, deliberately), and `db.t4g.micro` allows roughly
85 connections. Without the ceiling, a retry storm after an outage would exhaust connections and
take the dashboard down with the ingest path.

**What to do.**

1. Confirm nothing is lost — as in §3.3, agents buffer and retry with exponential backoff and full
   jitter. The jitter matters here: it is what stops an office's agents retrying in lockstep after
   a wifi outage.
2. If this is a one-off after an outage, let it drain.
3. If it recurs at steady state, the fleet has outgrown the ceiling. Raise
   `ingest_reserved_concurrency` **and** the instance class together — raising concurrency alone
   moves the failure from a 429 the agent handles gracefully to connection exhaustion, which takes
   the dashboard with it. `infra/variables.tf` names scaling the instance class as the path before
   reaching for RDS Proxy.

### 3.5 `worklens-prod-rds-free-storage-low`

**What it means.** Free storage is below 20 % of allocated. The threshold is computed in
`infra/modules/alarms/main.tf` as a percentage of `rds_allocated_storage_gb` rather than hard-coded
in bytes, because a fixed byte threshold becomes meaningless the moment the volume is resized. The
module exports the computed value as `rds_free_storage_threshold_bytes` specifically so a runbook
can quote the same number the alarm uses, but the root stack does not re-export it, so read it from
CloudWatch instead:

```bash
aws cloudwatch describe-alarms --region ap-south-1 --alarm-names worklens-prod-rds-free-storage-low --query 'MetricAlarms[0].[Threshold,StateValue,StateReason]'
```

The root stack passes `module.database.allocated_storage` (the instance's *current*
allocation, read from the resource) rather than the input variable, specifically so storage
autoscaling does not silently tighten the threshold.

**What to do.**

1. Storage autoscaling is on by default up to `db_max_allocated_storage` (100 GiB against an
   initial 20), so RDS may already be growing the volume. Check:

```bash
aws rds describe-db-instances --region ap-south-1 --db-instance-identifier worklens-prod-pg --query 'DBInstances[0].[AllocatedStorage,MaxAllocatedStorage,PendingModifiedValues]'
```

2. If growth is real rather than a spike, the cause is almost always `activity_events`. Check that
   retention is running (§6.2) before adding storage — a sweeper that has been failing silently for
   weeks is a more likely cause than genuine growth.
3. Remember this alarm is `treat_missing_data = "breaching"`. If it fired during maintenance and
   the metric simply stopped, look at whether the instance was available rather than at storage.

### 3.6 `worklens-prod-rds-cpu-high`

**What it means.** Average CPU above 80 % for ten minutes on a `db.t4g.micro`. The instance is
burstable, so sustained high CPU also burns CPU credits — and once those are exhausted the instance
is throttled to baseline, which presents as everything being slow rather than as high CPU.

**What to do.**

1. Check when it started and what coincides. The two scheduled jobs run at 20:45 and 22:00 UTC; a
   spike inside those windows is aggregation or retention doing bounded work, and is expected.
2. `log_min_duration_statement` is 1000 ms, so slow queries are already in
   `/aws/rds/instance/worklens-prod-pg/postgresql`. Note that `log_statement = 'ddl'` means DML
   statement text is *not* logged — deliberately, so no employee data reaches CloudWatch through
   the query log. You get durations and query ids, not the parameters.
3. Performance Insights is off (`performance_insights_enabled` default `false`, a cost decision
   recorded in `docs/PLAN.md` §10). Turning it on is a modify with no downtime and is the right
   move if this recurs.

### 3.7 `worklens-prod-schedule-dlq-not-empty`

**What it means.** A scheduled invocation failed every retry and EventBridge dead-lettered it. This
is the highest-signal alarm in the stack: it is the only one that says a *night of work did not
happen* rather than that something errored.

The queue is shared by all three schedules, so the alarm tells you *something* failed and you have
to read the message to know which. The alarm text assumes aggregation because that is the most
likely and most consequential case.

**What to do.**

1. Read a message without consuming it destructively — note that receiving makes it invisible for
   the visibility timeout, so read it once and act on what you see:

```bash
aws sqs receive-message --region ap-south-1 --queue-url "$(terraform -chdir=infra output -raw schedule_dead_letter_queue_url)" --max-number-of-messages 10 --message-attribute-names All
```

2. The message body is the EventBridge target input, so it identifies the job:
   `{"source":"schedule","lookback_days":3}` is aggregation,
   `{"source":"schedule","max_deletions_per_run":200000}` is retention,
   `{"source":"schedule"}` alone is the nonce sweeper.
3. Read the corresponding function's log around the failure time to find out *why*.
4. Recover:
   - **Aggregation** — the next scheduled run recomputes three days and repairs it on its own.
     If you need the timesheets before then, §5.
   - **Retention** — the next daily run picks up the backlog. Nothing was deleted that should not
     have been.
   - **Nonce sweeper** — `device_nonces` grew for an hour. Harmless; the next hourly run trims it.
5. There is **no automatic redrive** back to Lambda. The queue is for evidence, not replay. Delete
   the message once you have acted on it, or it holds the alarm in `ALARM` indefinitely:

```bash
aws sqs purge-queue --region ap-south-1 --queue-url "$(terraform -chdir=infra output -raw schedule_dead_letter_queue_url)"
```

Messages are retained for `dlq_retention_seconds` (default 1 209 600 — 14 days, the SQS maximum).

### 3.8 The other Lambda error alarms

| Alarm suffix | What an error means | Urgency |
|---|---|---|
| `pre-token-generation` | Dashboard logins are failing. The trigger reads roles and MFA status from Postgres, so this is usually the database or the Cognito interface endpoint. | Immediate — nobody can log in. |
| `reporting-api` | Dashboard reads failing. Employees cannot see their own timesheets either. | High. |
| `admin-api` | Administrative writes failing: config changes, device revocation, deletion requests. Revocation failing is a security concern, not just an inconvenience. | High. |
| `enroll` | New devices cannot be set up. Existing devices unaffected. | Low unless mid-rollout. |
| `device-config` | Agents cannot fetch policy. They keep using the cached policy, or the least-invasive defaults if they have never fetched one. Fails safe. | Low. |
| `heartbeat` | Liveness stops being recorded. Capture and upload are unaffected, but `last_seen_at` goes stale and your weekly liveness check becomes meaningless. | Low, but it blinds a monitoring check. |
| `notice-ack` | An employee acknowledged the notice and the acknowledgement did not record. They will be shown it again. Nothing is captured until it records. | Low. |
| `screenshot-presign` / `screenshot-complete` | Screenshot uploads failing. Off by default; only relevant where enabled. A presign row with no completed upload is swept to `expired` after 24 hours by the retention sweeper. | Low. |
| `nonce-sweeper` | Replay nonces are not being expired. `device_nonces` grows. Not a security hole — the *retention* is what protects replay, and it is only ever too long here. | Low. |
| `db-migrate` | A migration failed. Any error matters; the migration ledger tells you which one. | Immediate during a deploy. |

---

## 4. Finding a request by its id

When an employee or an admin reports an error, the dashboard shows them a request id. It comes from
`backend/src/shared/errors.ts`:

```json
{ "error": { "code": "INTERNAL_ERROR", "message": "An internal error occurred.", "requestId": "..." } }
```

The dashboard surfaces it through `ApiError.requestId` (`dashboard/src/lib/api.ts`) and
`action-support.ts`. **That id is the API Gateway request id**, not something the backend invented:
`withHandler` in `backend/src/shared/http.ts` takes `event.requestContext.requestId`, falls back to
the Lambda request id, and only generates a UUID if neither exists (which in a deployed stack means
never). So the same value appears in three places: the user's screen, the Lambda log, and the API
Gateway access log.

### The log format

`backend/src/shared/logger.ts` writes one JSON object per line:

```json
{"level":"error","message":"request failed","timestamp":"2026-08-20T12:34:56.789Z","environment":"prod","requestId":"...","handler":"reporting-api","method":"GET","path":"/v1/employees/.../timesheets","orgId":"...","userId":"...","role":"owner","status":500,"code":"INTERNAL_ERROR","durationMs":143}
```

`requestId`, `handler`, `method` and `path` are bound by `withHandler` on every line. `orgId`,
`userId` and `role` are added once the caller is authenticated (`boundContext` in
`backend/src/middleware/cognitoAuth.ts`). `warn` and above go to `console.error`, so CloudWatch
separates them into stderr and "show me only the problems" is a filter rather than a search.

Two categories of field never appear:

- **Credentials.** Any key containing `secret`, `password`, `token`, `credential`, `authorization`,
  `signature`, `apikey`, `privatekey`, `rootkey`, `cookie`, `sessionid` (case-insensitive substring,
  at any nesting depth) is replaced with `[redacted]`. Buffers become `[buffer N bytes]`. There is
  no path to the log that skips this.
- **Window and page titles.** Keys matching `window_title`, `url_title`, `page_title` and their
  camelCase forms become `[redacted:personal-data]` unless `LOG_REQUEST_BODIES` is on — and
  `backend/src/shared/config.ts` refuses to load with it on when `ENVIRONMENT` is `prod`.

So a log line will tell you *that* a window sample failed validation and never *what the title
was*. That is deliberate, and it means some debugging has to be done against the database rather
than the log.

### Looking one up

Which log group depends on which function served the route. `infra/modules/api/main.tf`'s `routes`
map is the authority; in practice reads are `reporting-api`, administrative writes are `admin-api`,
device routes are their own functions, and `POST /aggregation/run` goes straight at
`aggregate-timesheets`. If you do not know, query them all:

```bash
aws logs start-query --region ap-south-1 --start-time "$(date -v-2H +%s)" --end-time "$(date +%s)" --log-group-names /aws/lambda/worklens-prod-reporting-api /aws/lambda/worklens-prod-admin-api --query-string 'fields @timestamp, level, message, handler, method, path, status, code, orgId, userId | filter requestId = "REQUEST_ID_HERE" | sort @timestamp asc'
```

Then fetch the result with the returned query id:

```bash
aws logs get-query-results --region ap-south-1 --query-id QUERY_ID_HERE
```

The API Gateway access log carries the same id alongside `status`, `wafStatus`,
`integrationLatency` and `sourceIp` — that is where you look when the request never reached a
handler at all (a WAF block, an authorizer rejection, a throttle):

```bash
aws logs start-query --region ap-south-1 --start-time "$(date -v-2H +%s)" --end-time "$(date +%s)" --log-group-names /aws/apigateway/worklens-prod/access --query-string 'fields @timestamp, httpMethod, resourcePath, status, wafStatus, sourceIp, errorMessage | filter requestId = "REQUEST_ID_HERE"'
```

**If the id is not in either place, that is itself the finding.** The two cases are a request that
never arrived (client-side, DNS, TLS pinning, or the agent never sent it) and a log group whose
retention has lapsed — `var.log_retention_days` defaults to 30, deliberately short because
application logs can contain personal data and a long retention makes CloudWatch a second copy of
the activity database.

---

## 5. Re-running aggregation

### Why it is safe

`upsertTimesheet` in `backend/src/aggregation/repository.ts` keys on
`(org_id, employee_id, work_date)` with `on conflict ... do update`, and the child tables
(`timesheet_app_totals`, `_site_totals`, `_category_totals`, `_project_totals`) are
delete-then-insert rather than upserted per key — because a recomputation can legitimately *remove*
a bucket, such as an app the employee no longer used or a project whose rule was deleted.

The consequence is that **running aggregation twice over the same range produces the same result as
running it once.** There is no accumulation, no double counting, and no partial state that a second
run makes worse. The nightly schedule relies on this: it recomputes `aggregation_lookback_days`
(default 3) days *every night*, so days two and three are recomputed from scratch each time.

Two behaviours to know before you re-run a historical range:

- **A day with no events deletes any timesheet that exists for it.** `runner.ts` calls
  `deleteTimesheet` when a requested day has no rollup, with the reasoning that "hours with no
  evidence behind them must not survive on a dashboard" — a deletion request may have erased the
  events. So re-running aggregation over a range whose events have been deleted by retention or by
  an erasure request **removes those timesheets**. That is correct behaviour and it is also
  irreversible.
- **A lookback longer than `retention_days_events` reaches past deleted data.** Harmless, but the
  recomputed numbers for those days will be based on whatever survives, which is not what the
  original run produced.

### Re-running

The reliable path is a direct Lambda invoke. Aggregate one organisation over an explicit range:

```bash
aws lambda invoke --region ap-south-1 --cli-binary-format raw-in-base64-out --function-name worklens-prod-aggregate-timesheets --payload '{"source":"manual","org_id":"ORG_UUID","from":"2026-08-10","to":"2026-08-17"}' /dev/stdout
```

One employee, which is what you want when §7 has identified a single person:

```bash
aws lambda invoke --region ap-south-1 --cli-binary-format raw-in-base64-out --function-name worklens-prod-aggregate-timesheets --payload '{"source":"manual","org_id":"ORG_UUID","employee_id":"EMPLOYEE_UUID","from":"2026-08-10","to":"2026-08-17"}' /dev/stdout
```

Reproduce exactly what the schedule does, for every organisation:

```bash
aws lambda invoke --region ap-south-1 --cli-binary-format raw-in-base64-out --function-name worklens-prod-aggregate-timesheets --payload '{"source":"manual","lookback_days":3}' /dev/stdout
```

The event contract is `AggregateEvent` in `backend/src/handlers/jobs/aggregateTimesheets.ts`:

| Field | Meaning |
|---|---|
| `org_id` | Restrict to one organisation. Omitted means every organisation. |
| `employee_id` | Restrict to one employee. **Requires `org_id`** — the handler throws otherwise, because looking an employee up across tenants is exactly the cross-tenant query the schema is arranged to prevent. |
| `from`, `to` | Explicit local dates, `YYYY-MM-DD`. Override `lookback_days`. Validated against a regex; a malformed date throws rather than being coerced. |
| `lookback_days` | 1–31. Defaults to `AGGREGATION_LOOKBACK_DAYS`, which is 3. |
| `source` | Free text, appears in every log line for the run. Use it — `"manual"` versus `"schedule"` is how you tell your run apart from the nightly one afterwards. |

Dates are *local* dates, and each employee's day boundaries are computed in that employee's own
timezone inside the job (`aggregation/zone.ts`), so one run over the same `from`/`to` can cover
different UTC instants for different people. That is intentional and it is why the response reports
`from`/`to` per organisation.

### Reading the response

```json
{"ok":true,"organisations":1,"employeesProcessed":48,"employeesFailed":0,"daysWritten":384,"daysDeleted":0,"eventsRead":52104,"implausibleDays":0,"truncatedEmployees":0,"durationMs":41203}
```

Four fields deserve attention:

- **`employeesFailed > 0`** — someone was skipped. `ok` is still `true`. The per-employee `error`
  is in `results[].outcomes[]`, and the log carries `aggregation failed for one employee; continuing
  with the rest` with the employee id.
- **`implausibleDays > 0`** — a rollup failed the plausibility check (more tracked seconds than the
  local day contains, and the check is day-length-aware so DST transitions do not false-positive).
  **The day is written anyway**, deliberately: "a too-large timesheet somebody can investigate is
  more useful than a missing one nobody can explain." Investigate it; do not assume the number is
  right.
- **`truncatedEmployees > 0`** — an employee's event window hit `MAX_EVENTS_PER_EMPLOYEE`
  (250 000). Their timesheets **understate** their hours. This is logged at `error` as `event window
  truncated; the resulting timesheets understate this employee`. At a 60-second sample interval with
  coalescing, 250 000 events over a three-day window is far above any legitimate volume, so this
  means a runaway agent rather than a busy employee.
- **`daysDeleted > 0`** — timesheets were removed because those days now have no events. Expected
  after an erasure request; suspicious otherwise.

### The `POST /v1/aggregation/run` endpoint

`infra/modules/api/main.tf` wires this route directly at the `aggregate-timesheets` function rather
than proxying it through `admin-api`, because an in-VPC Lambda has no route to the Lambda control
plane without a NAT gateway (deviation D6). **As the code stands, that route does not work** — see
§14.2. Use the Lambda invoke above.

---

## 6. The scheduled jobs

Three EventBridge rules, defined in `infra/modules/scheduling/main.tf`. Cron expressions are always
UTC.

| Job | Function | Schedule (default) | Local (IST) | Input |
|---|---|---|---|---|
| `aggregate-timesheets` | `worklens-prod-aggregate-timesheets` | `cron(45 20 * * ? *)` | 02:15 | `{"source":"schedule","lookback_days":3}` |
| `retention-sweeper` | `worklens-prod-retention-sweeper` | `cron(0 22 * * ? *)` | 03:30 | `{"source":"schedule","max_deletions_per_run":200000}` |
| `nonce-sweeper` | `worklens-prod-nonce-sweeper` | `rate(1 hour)` | hourly | `{"source":"schedule"}` |

All three share one dead-letter queue and one retry policy: `maximum_retry_attempts` 3 within
`maximum_event_age_in_seconds` 7200. Two hours of retries covers a transient RDS failover or a
Lambda throttle; beyond that the run is stale and the next schedule is the better recovery path than
a very old retry.

**The order of the first two is load-bearing and nothing enforces it.** Aggregation must finish
turning yesterday's events into timesheets before retention is allowed to delete anything. Moving
retention earlier means events can be deleted before they have been rolled up, and the resulting
timesheet gap is unrecoverable. If you change either cron expression, check the other.

**`enable_schedules = false` stops retention as well as aggregation.** It exists so a first apply
does not run aggregation against an empty schema, and it is a data-protection problem if left off:
with it disabled, nothing deletes database rows past their retention window. The S3 lifecycle rule
still expires screenshot objects, which leaves rows pointing at objects that no longer exist. Turn
it on once the stack is live and do not leave it off.

To check what is actually in force:

```bash
terraform -chdir=infra output schedule_expressions
```

```bash
aws events list-targets-by-rule --region ap-south-1 --rule worklens-prod-retention-sweeper --query 'Targets[0].Input'
```

The second matters because `retention_max_deletions_per_run` is passed as *target input*, not as a
function environment variable. Reading the Lambda's configuration will not tell you the value in
force.

### 6.1 Aggregation

**What it does.** Reads `activity_events` for each employee over a window, cuts them into local
days in the employee's own timezone, applies category and project rules, and upserts `timesheets`
plus its four child total tables.

**When it runs.** 20:45 UTC daily. That is 02:15 IST — after the end of an Indian working day and
before anyone opens a dashboard the next morning.

**The window.** `lookback_days` (3) days back from today, in the employee's timezone, plus a
61-minute lookbehind on the event query. The lookbehind exists because an event may span up to an
hour and is indexed by when it *started*, so an event beginning at 23:50 has to be found when
aggregating the following day. Rollups produced for days outside the requested range are discarded
rather than written — writing them would replace a settled day using only its final ten minutes.

**Why three days rather than one.** This is the single most important thing to understand about
this job. An agent that was offline overnight uploads yesterday's events *today*, and that late
data has to land in the right day's timesheet. If the lookback were 1, an employee whose laptop was
in a bag on Tuesday would have an empty Tuesday for ever, because Wednesday's run would only ever
look at Wednesday. Three days is the buffer for ordinary offline behaviour. It is not enough for a
laptop that was off for a week — see §7.4.

**If it fails.** The invocation is retried, then dead-lettered. That night's timesheets are
missing. The next night's run recomputes three days and repairs it without intervention. The
failure is silent to users: the dashboard shows employees with no hours.

**Is it safe to re-run.** Yes, unconditionally, for the reasons in §5 — it is an idempotent upsert
keyed on `(org_id, employee_id, work_date)`. The one caveat is that a day with no events has its
timesheet deleted, so re-running over a range whose events have since been erased removes those
timesheets.

### 6.2 The retention sweeper

**What it does.** Deletes employee data past the window configured per organisation in
`monitoring_config` — `retention_days_events` (default 90) and `retention_days_screenshots`
(default 30, and the schema forbids it exceeding the events window, because keeping images longer
than the activity that explains them serves no legitimate purpose). It also marks screenshot
presigns that never completed as `expired` after 24 hours.

**When it runs.** 22:00 UTC daily, deliberately offset from aggregation.

**Order of operations, and why it is the way round it is.** For each organisation, screenshots
first, then events. Within screenshots, **the S3 objects are deleted before the database rows that
point at them.** That order is the whole point, and it is the same order the erasure path uses
(`docs/SECURITY.md` §2.4):

- Rows first, then a crash → images sit in the bucket with nothing in the database referring to
  them. Unreachable through the application, invisible to every retention report, removable only by
  somebody reconciling the bucket by hand. **An invisible orphan object.**
- Objects first, then a crash → a row points at an object that is already gone. The next run deletes
  the row, and in the meantime a presign simply fails. **A recoverable orphan row.**

The sweeper also never deletes a row whose object survived: `DeleteObjects` reports per-key errors,
and only the keys that actually went are used to build the row delete. Deleting a row whose object
survived would strand the image permanently — the same failure, arrived at differently.

Screenshots go before events for a related reason: their retention window is never longer than the
events' window, so doing them first means a run that exhausts its budget has removed the more
sensitive data.

**The ceiling.** `max_deletions_per_run` (200 000, floor 1000 enforced in the handler) bounds one
run across all organisations. It exists so a first run against a long backlog, or a run after
somebody shortens a retention window sharply, cannot become an unbounded delete that times out
half-way through a 300-second budget. The response reports `moreRemaining: true` and the next run
continues. Rows go in batches of 5000 (events, selected by `ctid`) and 1000 (screenshots, matching
S3's `DeleteObjects` limit) to keep any single lock short so ingest is never blocked for long.

**If it fails.** Data stays past its retention window. Nothing user-visible changes. A single
organisation's failure does not stop the others — that would mean one bad configuration halting
everybody's retention, which is a compliance problem rather than an inconvenience.

**Is it safe to re-run.** Yes. Everything it does is "delete what is past the window", so a second
run deletes what the first did not reach and finds nothing else to do. Dry-run it first to see the
size of the backlog without deleting anything:

```bash
aws lambda invoke --region ap-south-1 --cli-binary-format raw-in-base64-out --function-name worklens-prod-retention-sweeper --payload '{"source":"manual","dry_run":true}' /dev/stdout
```

Then a real run, optionally scoped to one organisation and with a larger budget:

```bash
aws lambda invoke --region ap-south-1 --cli-binary-format raw-in-base64-out --function-name worklens-prod-retention-sweeper --payload '{"source":"manual","org_id":"ORG_UUID","max_deletions_per_run":500000}' /dev/stdout
```

Watch the 300-second function timeout when raising the budget. A run that times out mid-batch is
recoverable (objects before rows, as above), but it wastes the work.

**One caveat on `dry_run`.** It counts rows past retention and reports them as `eventsDeleted` /
`screenshotsDeleted` with `dryRun: true`. It does not exercise the S3 path at all, so it will not
tell you that S3 permissions are broken.

### 6.3 The nonce sweeper

**What it does.** Expires rows from `device_nonces`, the replay-protection table. Every signed
agent request claims a nonce; without expiry the table grows without bound.

**When it runs.** Hourly, via `rate(1 hour)` — which counts from when the rule was created, not
from the top of the hour, so do not expect it at :00.

**Why it is separate from retention.** Retention deletes *employee data* on a cadence the
organisation configured. This deletes *security bookkeeping* on a cadence dictated by the signature
window. Conflating them would tie a security control to a dashboard setting: shorten the retention
window and you would also shorten the replay-protection window, which is not a trade anybody would
choose deliberately.

**The one invariant.** `NONCE_RETENTION_SECONDS` (default 600) must exceed
`HMAC_TIMESTAMP_SKEW_SECONDS` (default 300). Expiring a nonce while its timestamp is still accepted
reopens exactly the replay hole the nonce exists to close. This is checked in three places:
`config.ts` at load, the handler at invoke, and the variable descriptions in
`infra/modules/scheduling/variables.tf`. The handler refuses rather than trusting the caller.

**If it fails.** `device_nonces` grows for an hour. Not a security problem — the retention interval
only ever ends up *too long*, which is the safe direction. The table is indexed for the sweep.

**Is it safe to re-run.** Yes, and it is cheap:

```bash
aws lambda invoke --region ap-south-1 --cli-binary-format raw-in-base64-out --function-name worklens-prod-nonce-sweeper --payload '{"source":"manual"}' /dev/stdout
```

Do **not** pass `retention_seconds` below the signature window. The handler will refuse, which is
the intended behaviour, but there is no reason to try.

### 6.4 `db-migrate` is not scheduled

It exists because RDS has no public access, so a laptop cannot reach the database and there is no
bastion. It runs when you invoke it:

```bash
aws lambda invoke --region ap-south-1 --cli-binary-format raw-in-base64-out --function-name worklens-prod-db-migrate --payload '{}' /dev/stdout
```

Migrations run as the RDS **master** user, not `worklens_app`, because `0003_app_role.sql` grants
`rds_iam` and only a member of `rds_superuser` can do that. Migrations are forward-only.

---

## 7. An employee's timesheet is missing or wrong

This is the most common real complaint and the one with the longest diagnostic path, because at
least six different things produce the same symptom. Work down the list — it is ordered so that the
cheap checks that explain most cases come first.

The complaint has two shapes and they diverge early:

- **"There are no hours at all"** → §7.1 onwards.
- **"The hours are wrong"** → skip to §7.6.

### 7.1 Is anything being captured on that laptop?

Three of the agent's correct behaviours are indistinguishable from "broken" from the server side,
and `docs/AGENT.md` §8 makes the same point. On the device:

```bash
worklens-agentctl doctor
```

It exits non-zero on any failure and reports what to do rather than only what is wrong. The checks
that explain a missing timesheet, in the order it runs them:

| Check | What a failure means |
|---|---|
| Data directory | The agent cannot write. On Windows it runs as a logon task in the user's own session, so a wrong session means a wrong `LOCALAPPDATA`. |
| Configuration | Not enrolled, or no API URL. Nothing is captured. |
| Enrolment | No `credentials.json`, or an unusable one. **Nothing is captured.** Reports the device id and key version when healthy. |
| Local buffer | Unreadable or corrupt. Also warns when events have been waiting over a day, which means uploads are failing rather than capture. |
| Notice acknowledged | The employee has not accepted the first-run notice. **Nothing is captured, by design.** |
| Monitoring policy | No cached config yet, so the agent is using the least-invasive defaults: titles off, URLs off, screenshots off, work-hours-only on. |
| Clock | The machine's skew against the server's `Date` header. Beyond ±300 s every signed request is rejected with `TIMESTAMP_OUT_OF_WINDOW`, which otherwise presents as an unexplained 401. |
| API reachability | A real TLS handshake against the configured pins. This is the check that catches a corporate interception proxy — a pin mismatch only surfaces when the certificate is actually verified. |
| Scheduled task | The logon task is missing or disabled, so the agent is not starting. |

Two of these are worth stating plainly to whoever complained, because they are correct rather than
broken: **an unacknowledged notice means no capture**, and **capture outside work hours does not
happen at all**.

### 7.2 Were those hours filtered out locally?

This is the answer more often than anything else, and it is important because **the filtering
happens on the device, before upload.** `agent/internal/privacy/rules.go` decides, in this order:

1. **Work hours.** If `work_hours_only` is on (it is, by default), a sample outside
   `work_hours_start`–`work_hours_end` on a day in `work_days` is dropped with reason
   `outside working hours`. Defaults are 09:00–17:30, Monday–Friday, evaluated **in the employee's
   timezone**. Overnight windows are handled.
2. **Excluded application**, checked before the window title is even looked at.
3. **Excluded URL**, matched against both the derived host and the raw title.

Screenshots run the same work-hours check through `AllowScreenshot`, deliberately reusing
`withinWorkHours` so the two cannot diverge — and the check runs *before* the capture, so no image
of a screen outside working hours exists even momentarily in memory.

The operational consequence: **there is no server-side record of what was filtered.** An employee
who worked Saturday, in an organisation with `work_days = {1,2,3,4,5}`, has no Saturday events
anywhere — not filtered-and-marked, simply never recorded. No amount of re-running aggregation will
produce them. Check the org's configuration before looking anywhere else:

- Dashboard: Settings → Monitoring.
- Or the device's own view: `worklens-agentctl status` shows the policy version and settings in
  force on that machine.

A related trap: **a changed sample or screenshot interval needs an agent restart.** Exclusions,
work hours and the capture toggles apply on the next config poll; the two intervals are read once
when the loops start. The agent logs this when it applies a config change.

### 7.3 Did the events reach the server?

If capture is happening and work hours are not the answer, look at the buffer. `doctor`'s **Local
buffer** check reports the pending count and the age of the oldest event, and warns when the oldest
exceeds a day.

A backed-up buffer means uploads are failing, not capture. The agent's claim protocol
(`agent/internal/store/store.go`) is:

```
AppendEvent   → claimed_by IS NULL
ClaimBatch    → claimed_by = <id>, claimed_at = now
DeleteBatch   → rows gone, after a 2xx
ReleaseBatch  → claimed_by = NULL, after a retryable failure
Recover       → releases claims older than 15 minutes, at startup
```

Rows are deleted only after the server acknowledges them, and a crash mid-upload leaves rows claimed
rather than lost — `Recover` releases claims older than `DefaultStaleClaimAfter` (15 minutes) at
startup. So a full buffer is a *delivery* problem and the events are still there. What the protocol
does **not** do is prevent duplicates; that is the server's job, deduplicating on
`(device_id, client_event_id)`, which is the only place it can be enforced.

The failure codes worth recognising:

| Symptom | Cause |
|---|---|
| `TIMESTAMP_OUT_OF_WINDOW` | The laptop's clock. Retried, because NTP may correct it between attempts. |
| `DEVICE_REVOKED` | Terminal. The agent stops trying. See §9. |
| `INVALID_SIGNATURE` on every request from every device | The device root key, not the agent. See §10. |
| A pin mismatch | Never retried. A TLS interception proxy. `doctor`'s reachability check catches it. |
| `QUOTA_EXCEEDED` (429) | `DEVICE_QUOTA_EVENTS_PER_WINDOW` (5000 per hour by default) exceeded. |

And the one case where data really is gone: **the buffer cap.** 250 MB or 14 days, whichever comes
first. Over the cap, the **oldest** events are dropped, and an `agent_health` event records how
many. So a gap in a timesheet caused by a long outage is always explainable — look for
`agent_health` events in the employee's activity around the gap.

### 7.4 Did aggregation run for that day?

If the events are in `activity_events` but no timesheet exists, aggregation is the gap.

1. Check the DLQ (§3.7) for a dead-lettered run.
2. Check the aggregation log for the night in question:

```bash
aws logs tail /aws/lambda/worklens-prod-aggregate-timesheets --region ap-south-1 --since 24h --filter-pattern '"could not be aggregated"'
```

3. Look for the specific per-employee failures, which do **not** trip any alarm:
   - `skipping an employee with an invalid timezone` — the employee's `timezone` column is not a
     usable IANA zone. The job refuses to fall back to UTC, because that would quietly produce
     timesheets cut on the wrong boundary, which is plausible-looking and wrong. Fix the employee
     record and re-run for that employee.
   - `aggregation failed for one employee; continuing with the rest` — read the error.
   - `event window truncated` — the timesheets exist but **understate** the hours.

4. **The lookback window is the most likely cause for an older day.** `AGGREGATION_LOOKBACK_DAYS`
   is 3. An agent that was offline for a week uploads all of it on the day it reconnects, and the
   nightly run only recomputes the last three days — so the older days' events are in the database
   with no timesheet built from them, and no further scheduled run will ever build one. **This is
   the single most common reason a historical timesheet is permanently missing, and it is fixed by
   an explicit re-run over the range (§5), not by waiting.**

### 7.5 Was the data deleted?

Two paths delete events, and both are legitimate:

- **Retention.** Past `retention_days_events` (default 90) the events are gone, and re-running
  aggregation over those dates will *delete* the timesheets rather than rebuild them (§5). If the
  complaint is about a date older than the retention window, that is the answer.
- **An erasure request.** Check the deletion request list (§8) and the audit log for
  `DELETION_REQUEST_EXECUTE` against that employee.

The audit log is where this is answerable, and it cannot have been tidied up afterwards — see §12.

### 7.6 The hours are wrong rather than missing

| Symptom | Where to look |
|---|---|
| Hours far too high | `implausibleDays` in the aggregation response, and the log line `implausible rollup written for investigation`. The day was written *and* flagged. |
| Hours too low, one employee | `truncatedEmployees` — the event window hit 250 000 events. The log names the employee. |
| Idle time attributed to an app | It cannot be. Idle samples carry no attribution, enforced in four independent places (`docs/AGENT.md` §1, `docs/SECURITY.md` §2.8). If you are seeing this, one of those four layers has been removed. |
| Wrong day boundary | The employee's `timezone`, not the job's schedule. Days are cut per employee in their own timezone. |
| Project attribution wrong or absent | Project rules are applied *during aggregation*, so changing a rule does not retroactively re-attribute anything until the affected range is re-aggregated. Also check the log for `project rules disabled during aggregation`, which means a regex rule exceeded `AGGREGATION_REGEX_BUDGET_MS` (5 ms) and was dropped for that run. |
| Some events "corrected" | `some events needed correcting` in the log, with `skipped` and `clamped` counts. `duration_seconds` is capped at 3600 by the schema, so a stalled clock or a laptop resumed from sleep cannot inject an implausible span. |
| A site or URL missing | There are no full URLs, ever — only what a browser window title yields, and often not even a host. `docs/AGENT.md` §5. Not a fault. |

---

## 8. Handling a data-deletion request

DPDP-style erasure. The flow is deliberately **two steps** — request, then execute — implemented in
`backend/src/handlers/dashboard/admin.ts` against the `data_deletion_requests` table (note the
table name; the API path is `/deletion-requests`).

Both steps require the `owner` role (`POLICY.ownerWrite`) plus a configured MFA factor, and both are
audited.

### Step 1 — record the request

`POST /v1/deletion-requests` with `employee_id`, a `scope`, and an optional `reason`. Scope is one
of `all`, `screenshots`, `events` (checked by the schema). This **deletes nothing**. It inserts a
row with `status = 'pending'` and writes a `DELETION_REQUEST_CREATE` audit entry.

The split is the point: it creates a record of who asked, for whom, for what, and why, that exists
*before* anything is destroyed. A one-step erasure would leave you unable to show, afterwards, that
the deletion was requested rather than improvised.

### Step 2 — execute it

`POST /v1/deletion-requests/{id}/execute`. This is the destructive step. It:

1. Claims the request row inside a transaction. If it is not `pending` it returns 409 —
   `This deletion request has already been completed.` A double-execute is refused, not repeated.
2. If the scope covers screenshots, loops in batches: selects a batch, **deletes the S3 objects,
   then deletes the rows.** Same ordering as the retention sweeper and for the same reason (§6.2).
   A per-key S3 failure is raised as an error rather than ignored, because "ignoring it would mean
   reporting a completed erasure while the images are still in the bucket, which is the one lie this
   endpoint must not tell."
3. If the scope covers events, deletes `activity_events` in batches.
4. Writes `status = 'completed'`, `completed_at`, and the actual `deleted_event_count` and
   `deleted_screenshot_count`.
5. Writes a `DELETION_REQUEST_EXECUTE` audit entry carrying those counts.

The database transaction spans the S3 calls. That is normally a mistake, and with `DB_POOL_MAX = 1`
it occupies the container's only connection for the duration — accepted deliberately, because the
alternative is committing row deletions before the bytes are gone. The function timeout is 30
seconds, so a very large erasure can time out; the request stays `pending` and re-executing is safe
because `DeleteObjects` is idempotent.

### What is deliberately not deleted

**The `audit_log` rows** describing this erasure and the accesses that preceded it. That is stated
in `docs/RESPONSIBLE_USE.md` and it is not an oversight: a deletion you cannot evidence is worse
than no deletion at all. It is also enforced rather than intended — `worklens_app` has no `DELETE`
on `audit_log` (§12).

**Timesheets are not deleted by this endpoint either.** They are removed the next time aggregation
covers those dates, because a day with no events has its timesheet deleted (§5). If the erasure must
be complete immediately, run aggregation over the affected range straight afterwards:

```bash
aws lambda invoke --region ap-south-1 --cli-binary-format raw-in-base64-out --function-name worklens-prod-aggregate-timesheets --payload '{"source":"post-erasure","org_id":"ORG_UUID","employee_id":"EMPLOYEE_UUID","from":"2026-05-01","to":"2026-08-20"}' /dev/stdout
```

### The S3 versioning caveat, which matters for what you tell the employee

The screenshot bucket has **versioning enabled** (`infra/modules/storage/main.tf`). Both the erasure
path and the retention sweeper issue a plain `DeleteObject`/`DeleteObjects` with no version id. On a
versioned bucket that creates a delete marker and **retains the previous version**. The bytes are
gone from the application's point of view immediately — unreachable, unpresignable — but they are
not gone from S3 until the `expire-noncurrent-versions` lifecycle rule reaps them, up to
`screenshot_noncurrent_version_days` (default **7**) later.

So the honest statement to an employee is "deleted from the system immediately and purged from
storage within seven days", not "deleted immediately". If a deployment needs provable immediate
erasure, the delete has to be version-aware; this configuration does not make it so. The
`storage` module's README records the same caveat.

### Verifying afterwards

```bash
aws lambda invoke --region ap-south-1 --cli-binary-format raw-in-base64-out --function-name worklens-prod-retention-sweeper --payload '{"source":"verify","dry_run":true,"org_id":"ORG_UUID"}' /dev/stdout
```

A dry run that reports zero remaining for that organisation, plus the recorded counts on the
completed request row, plus the audit entry, is the evidence trail. `GET /v1/deletion-requests`
lists the requests and their outcomes.

---

## 9. Revoking a device

`POST /v1/devices/{id}/revoke`, or Settings → Devices in the dashboard. Owner role, audited as
`DEVICE_REVOKE` with the revocation timestamp in the metadata.

### What happens

Revocation is a single database write — `devices.revoked_at` — and it is checked on **every**
request, before any cryptography:

```ts
if (device.revoked_at !== null) {
  throw errors.deviceRevoked(device.id);
}
```

The ordering in `backend/src/middleware/deviceAuth.ts` is deliberate: revocation is checked before
the HMAC is verified, so a revoked device costs nothing to reject.

Because it is a database write rather than a credential expiry, **revocation takes effect on the
device's next request** — there is no TTL to wait out. The agent treats `DEVICE_REVOKED` as terminal
and stops retrying rather than hammering the API.

Re-revoking is safe: `revokeDevice` uses `coalesce(revoked_at, now())`, so the original moment is
preserved — which is the one that matters if anyone has to reconstruct when a laptop stopped being
trusted.

### What happens to data already uploaded

**Nothing. It stays, and it stays attributed to that employee.**

- Events already in `activity_events` remain and continue to be aggregated into timesheets.
- Screenshots already uploaded remain viewable, subject to their retention window.
- Both are removed on the normal schedule: retention (§6.2) or an erasure request (§8).

Revocation is an authentication control, not a deletion control. Conflating them would mean that
revoking a laptop erased an employee's payroll record, which is not what anybody wants from
"this device is no longer trusted".

Two things revocation does *not* do:

- **It does not stop the agent capturing.** The agent keeps sampling and buffering locally; its
  uploads are refused. To actually stop capture, the employee runs `worklens-agentctl unenroll`
  (and `uninstall` to remove the logon task). Revoke server-side *and* unenroll on the device.
- **It does not remove the buffered events on that laptop.** They sit in `buffer.db` until the
  cap ages them out, or until `unenroll` removes local data.

### When to revoke

- A lost or stolen laptop. This is the case the control exists for: the device secret is in
  `credentials.json` in the user's profile, and `docs/SECURITY.md` §4 is explicit that an attacker
  with code execution as that user can submit activity as that device **until it is revoked**.
- An employee leaving.
- A device being rebuilt or reassigned — revoke the old row and enrol fresh; a device id is not
  meant to be transferred.

### After revoking

Verify from the device list that `revoked_at` is set, and check the audit log for the
`DEVICE_REVOKE` entry. To bring the same machine back, mint a new enrolment token
(`POST /v1/devices/enrollment-tokens`) and enrol again — the token is single-use, only its SHA-256
is stored, and the value in the response is the only time it exists anywhere outside the operator's
terminal.

---

## 10. Rotating the device root key

### What the key is, and what rotation actually means

There is no per-device secret stored anywhere. `backend/src/shared/deviceSecretDerivation.ts`:

```
device_secret = base64url( HMAC-SHA256( root_key[v], "v<v>:<org_id>:<device_id>" ) )
```

The `devices` table stores only `key_version`. That is the entire credential record — a database
dump yields no working device credential (deviation D4, `docs/SECURITY.md` §2.1).

The version is inside the HMAC **message**, not merely used to select the key. If it were only a
selector, the same root key published under two version numbers would derive the same secret;
binding it into the message keeps each version's output domain distinct. This is why rotation works
the way it does.

The secret lives in Secrets Manager as `worklens-prod/device-root-key`, and the two ends disagree
about its shape today — see §14.1 before doing any of this.

### Rotation is additive, and that is the whole design

You do not replace the key. You **publish a new version alongside the old one**:

- `deriveDeviceSecret` looks up `keys.get(input.keyVersion)` using the version from the device's own
  row, so a device on v1 keeps working after v2 is published.
- `currentKeyVersion()` returns `Math.max(...keys.keys())`, so every *new* enrolment is issued
  against the highest version present.
- Devices move to the new version **as they re-enrol**, not on a schedule.

Consequently: publishing v2 breaks nothing. **Removing v1 while devices still reference it breaks
those devices**, and `deriveDeviceSecret` says so explicitly rather than failing obscurely:

```
Device references root key version 1, which is not present in the secret
(available: 2). A version was retired while devices were still using it;
re-publish it, or re-enrol those devices.
```

### When to rotate

- **The Terraform state has been exposed.** `random_password.device_root_key.result` is a state
  attribute, in plaintext. This is the one secret in the stack that state holds — the RDS master
  password never enters state, because RDS manages it. If state has ever been on a laptop, in a
  chat message, or in an unencrypted bucket, rotate.
- A suspected compromise of Secrets Manager or of a role that can read it.
- Periodically, as policy. There is no automatic rotation configured and none is needed for
  correctness.

### The procedure

1. **Read the current secret** and note the versions present.

```bash
aws secretsmanager get-secret-value --region ap-south-1 --secret-id worklens-prod/device-root-key --query SecretString --output text
```

2. **Find out which versions are actually in use** before you plan any retirement. There is no API
   for this, so query the database — via the dashboard's device list (which returns `key_version`
   per device) or a read against `devices`:

```sql
select key_version, count(*), count(*) filter (where revoked_at is null) as active from devices group by key_version order by key_version;
```

3. **Generate 32 bytes of new key material.** At least `MIN_ROOT_KEY_BYTES` (32) after base64
   decoding, or `parseRootKeys` refuses to load the secret at all — a short root key would silently
   weaken every secret derived from it, so it fails loudly instead.

```bash
openssl rand -base64 32
```

4. **Publish the new version alongside the existing ones**, in the shape the backend parses (see
   §14.1 — this is a flat map of version to base64 key, *not* the shape Terraform writes):

```bash
aws secretsmanager put-secret-value --region ap-south-1 --secret-id worklens-prod/device-root-key --secret-string '{"1":"EXISTING_BASE64_KEY","2":"NEW_BASE64_KEY"}'
```

5. **Let the Lambda containers cycle.** The root key map is cached for the life of the container
   with **no TTL** — deliberately, because a rotation that *adds* a version does not invalidate what
   is already cached, and one that *removes* a version requires the containers to cycle anyway.
   Lambda recycles containers within minutes to hours. To force it immediately, publish a trivial
   configuration change to each device-facing function, which replaces the execution environment.

6. **Verify a new enrolment lands on the new version.** Enrol one device and confirm its
   `key_version` is 2, in the device list or via `worklens-agentctl doctor`, which reports
   `device <id>, key version <n>`.

7. **Confirm existing devices still work.** They are on v1 and v1 is still published, so they
   should. Check for `INVALID_SIGNATURE` in the ingest log — a fleet-wide signature failure means
   the secret's shape or content is wrong, not that individual agents are broken.

8. **Migrate the fleet.** Each device has to re-enrol: mint a token, then on the laptop
   `worklens-agentctl unenroll` followed by `worklens-agentctl enroll --token wlen_...`. There is no
   server-driven re-key — the device secret never leaves the device after enrolment, so there is
   nothing to push.

9. **Only once every active device reports the new version, retire the old one.** The same
   add-then-remove discipline as the TLS pin rollover in `docs/SECURITY.md` §2.6: adding is safe,
   removing is what breaks a fleet.

```bash
aws secretsmanager put-secret-value --region ap-south-1 --secret-id worklens-prod/device-root-key --secret-string '{"2":"NEW_BASE64_KEY"}'
```

Revoked devices do not need re-enrolment; they are rejected before derivation.

### What Terraform will and will not do

`aws_secretsmanager_secret_version.device_root_key` carries `ignore_changes = [secret_string]`,
explicitly because rotation is an operational action:

```hcl
lifecycle {
    # Key rotation is an operational action (docs/OPERATIONS.md), not a
    # Terraform one. Without this, `apply` would revert a rotated key.
    ignore_changes = [secret_string]
}
```

So `terraform apply` after a rotation will not notice or revert it — which is the intent. Two
consequences:

- **`terraform state show` reports the original value indefinitely.** The live value is only in
  Secrets Manager. Do not use state as the source of truth after a rotation.
- **Never let Terraform recreate the secret on a live fleet.** Replacing it — a name change, a
  destroy and re-apply, a changed `project` or `environment` — generates a brand new root key, and
  every enrolled device's derived secret stops verifying at once. Recovery is re-enrolling the whole
  fleet. Related: `secret_recovery_window_days` (30) keeps the *name* reserved after a destroy, so a
  re-apply inside 30 days fails on a name conflict.

---

## 11. Restoring the database

### What the backup configuration actually is

From `infra/modules/database/main.tf` and `infra/variables.tf`:

| Setting | Value | Where |
|---|---|---|
| `backup_retention_period` | **7 days** | `var.db_backup_retention_days`, default 7, validated ≥ 1 and ≤ 35; the module additionally validates ≥ 7 with the message "docs/PLAN.md section 6 requires at least 7 days of automated backups" |
| Point-in-time recovery | **Enabled** — implied by a non-zero retention period | the variable's own description says zero would disable it |
| `backup_window` | `18:00-19:00` UTC | `var.backup_window` |
| `maintenance_window` | `sun:19:30-sun:20:30` UTC | `var.maintenance_window` |
| `copy_tags_to_snapshot` | `true` | hard-coded |
| `delete_automated_backups` | `false` | hard-coded — automated backups survive instance deletion |
| `skip_final_snapshot` | `false` | hard-coded |
| `final_snapshot_identifier` | `worklens-prod-pg-final` | derived from `name_prefix` |
| `deletion_protection` | `true` | `var.db_deletion_protection`, default true |
| `multi_az` | **`false`** | `var.db_multi_az`, default false — roughly doubles instance cost |
| Storage encryption | `true`, with the `rds` CMK | hard-coded |
| Manual snapshots | **none, and nothing creates any** | — |

**Seven days is the number.** Not thirty, not thirty-five. A problem discovered more than a week
after it was introduced is not recoverable from automated backups, and there is no manual-snapshot
schedule to fall back on. If your recovery-point requirement is longer than a week, raise
`db_backup_retention_days` (up to 35) or add a snapshot schedule — neither exists today.

Two further consequences worth stating:

- **Single-AZ.** There is no standby. An AZ failure is a restore, not a failover, and a restore is
  measured in tens of minutes at minimum.
- **`deletion_protection` is enforced by RDS, not by Terraform.** `prevent_destroy` is deliberately
  `false` on the resource, with the reasoning in the module: a `prevent_destroy` cannot be driven by
  a variable, so it would make tearing down a staging stack require editing a shared module. RDS's
  own flag blocks a deletion attempted from the console or the CLI too, which `prevent_destroy`
  would not.

Confirm what is actually there before planning a restore:

```bash
aws rds describe-db-instances --region ap-south-1 --db-instance-identifier worklens-prod-pg --query 'DBInstances[0].[BackupRetentionPeriod,LatestRestorableTime,MultiAZ,DeletionProtection,PreferredBackupWindow]'
```

```bash
aws rds describe-db-snapshots --region ap-south-1 --db-instance-identifier worklens-prod-pg --query 'DBSnapshots[].[DBSnapshotIdentifier,SnapshotCreateTime,SnapshotType]' --output table
```

`LatestRestorableTime` is the honest edge of what point-in-time recovery can give you — typically
within five minutes of now, but check rather than assume.

### The procedure

A restore creates a **new instance**. It never overwrites the existing one, which is the property
that makes the whole operation reversible.

1. **Stop the writers.** Disable the schedules so aggregation and retention are not writing into a
   database you are about to abandon:

```bash
aws events disable-rule --region ap-south-1 --name worklens-prod-aggregate-timesheets
```

```bash
aws events disable-rule --region ap-south-1 --name worklens-prod-retention-sweeper
```

Consider also setting `ingest_reserved_concurrency` to 0 for `ingest-events` — agents will buffer
and retry, losing nothing, which is exactly what the buffer is for.

2. **Read the original instance's security group**, because a restore inherits none of this and the
   RDS security group is not a root Terraform output. It is `module.network.rds_security_group_id`,
   the group that accepts 5432 from the Lambda group — not the Lambda group itself:

```bash
aws rds describe-db-instances --region ap-south-1 --db-instance-identifier worklens-prod-pg --query 'DBInstances[0].VpcSecurityGroups[].VpcSecurityGroupId' --output text
```

3. **Restore to a point in time**, naming the subnet group, security group and parameter group
   explicitly:

```bash
aws rds restore-db-instance-to-point-in-time --region ap-south-1 --source-db-instance-identifier worklens-prod-pg --target-db-instance-identifier worklens-prod-pg-restore --restore-time 2026-08-20T09:30:00Z --db-subnet-group-name worklens-prod-db --vpc-security-group-ids sg-EXAMPLE --db-parameter-group-name worklens-prod-pg16 --no-publicly-accessible --enable-iam-database-authentication --deletion-protection
```

   Or from a snapshot with `aws rds restore-db-instance-from-db-snapshot` and the same flags.

   **`--enable-iam-database-authentication` is not optional.** The application authenticates with
   `rds-db:connect` tokens; there is no database password in this configuration. A restored instance
   without IAM auth refuses every application connection, and the failure looks like a credentials
   problem rather than a missing flag.

4. **Wait, and check the roles came back.** `worklens_app` and `worklens_migrator` are created by
   migration `0003`, so they are *in* the restored data. What is not in the restored data is the IAM
   policy binding: the Lambda execution policies grant `rds-db:connect` on a resource ARN that
   embeds the **DbiResourceId** of the original instance. A restored instance has a new
   `DbiResourceId`, so those grants do not cover it.

   This is the step most likely to catch you out, and it is unverified. Get the new id:

```bash
aws rds describe-db-instances --region ap-south-1 --db-instance-identifier worklens-prod-pg-restore --query 'DBInstances[0].DbiResourceId'
```

   Then either rename the restored instance to the original identifier so Terraform's
   `db_iam_auth_resource_arn` regenerates on the next apply, or apply with the restored instance
   adopted into state. Read `infra/modules/database/outputs.tf` and the `stmt_db_connect` statement
   in `infra/modules/lambda/main.tf` before choosing.

5. **The master credential does not come across.** `manage_master_user_password = true` means RDS
   generates and rotates the master password into Secrets Manager for the *original* instance. A
   restored instance is not attached to that secret. `db-migrate` reads `DB_MASTER_SECRET_ARN`, so
   until the restored instance has a managed master credential of its own, migrations cannot run
   against it:

```bash
aws rds modify-db-instance --region ap-south-1 --db-instance-identifier worklens-prod-pg-restore --manage-master-user-password --master-user-secret-kms-key-id "$(terraform -chdir=infra output -raw rds_kms_key_arn)" --apply-immediately
```

   The application path does not need this — it uses IAM — but the migration path does.

6. **Cut over.** The application finds the database through the `DB_HOST` Lambda environment
   variable, set from `module.database.address`. Two options:
   - **Rename.** Rename the damaged instance out of the way and the restored one into
     `worklens-prod-pg`. The endpoint hostname follows the identifier, so `DB_HOST` keeps working
     with no redeploy. This is the shorter path and it is what makes the naming worth using.
   - **Re-point.** Adopt the restored instance into Terraform state and apply, so the Lambda
     environment is rewritten. Slower, cleaner, and it leaves state honest.

7. **Verify before re-enabling anything.** Check row counts and the latest `captured_at` in
   `activity_events`, then confirm the dashboard loads and `/v1/me` works.

8. **Re-enable the schedules, and restore ingest concurrency.**

```bash
aws events enable-rule --region ap-south-1 --name worklens-prod-aggregate-timesheets
```

```bash
aws events enable-rule --region ap-south-1 --name worklens-prod-retention-sweeper
```

9. **Re-aggregate the gap.** Events uploaded between the restore point and the cutover are gone
   from the database, but they may still be in agents' local buffers and will be re-uploaded —
   server-side deduplication on `(device_id, client_event_id)` makes that harmless. Once uploads
   have caught up, re-run aggregation over the affected range (§5). Because aggregation is an
   idempotent upsert, you can run it more than once as late data arrives.

10. **Delete the old instance only when you are certain**, and take a final snapshot when you do.
    `deletion_protection` will refuse until you turn it off, which is the friction it exists for.

### Two things that are not recoverable this way

- **Screenshot objects are not in the database.** They are in S3, with their own lifecycle. A
  database restore to a point before a retention sweep restores the *rows*; the objects those rows
  point at were deleted by the sweeper and, past `screenshot_noncurrent_version_days` (7), their
  versions are gone too. Presigns for those rows will fail.
- **A deleted CMK takes everything with it.** `kms_deletion_window_days` (default 30, minimum 7) is
  the only grace period. A destroy that schedules the `rds` key for deletion makes every snapshot
  encrypted under it permanently unreadable once the window lapses — and the same applies to the
  `s3` key and every screenshot object. There is no recovery. `infra/modules/observability/README.md`
  states this and it bears repeating in a restore runbook.

---

## 12. The audit log cannot be edited, and that is the point

`backend/migrations/0003_app_role.sql` grants the application role DML on every tenant table:

```sql
grant select, insert, update, delete on
    organizations, employees, users, projects, ... , data_deletion_requests
to worklens_app;
```

and then, separately and deliberately:

```sql
-- The audit log is append-only for the application. Without UPDATE or DELETE, a bug or
-- a compromised handler cannot rewrite or erase the record of who read whose data.
grant select, insert on audit_log to worklens_app;
```

`select` and `insert`. No `update`. No `delete`.

### What this means operationally

**You cannot correct the audit log, and neither can anyone else using the application's
credentials.** Not through the API, not through a hotfix, not by connecting as `worklens_app` with a
psql client. The grant is the enforcement, so it holds regardless of what the code does.

The consequences to plan around:

- **A wrong entry stays.** If an audit entry records the wrong subject because of a bug, the fix is
  a later corrective entry plus a note, not an edit. Design any correction as an append.
- **The log grows monotonically.** Nothing prunes it — the retention sweeper does not touch it, and
  could not. An erasure request deletes the employee's events and screenshots and leaves every
  audit entry about them intact, which is stated in `docs/RESPONSIBLE_USE.md`: a deletion you cannot
  evidence is worse than no deletion at all. Factor this into the storage growth you watch in §2.
- **Reading it is itself audited**, as `AUDIT_LOG_READ`. Not circular busywork: "who has been
  reviewing who has been looking at whose data" has an answer, and that read cannot be hidden
  afterwards for the same grant reason.

### Why it is worth defending

`docs/SECURITY.md` §4 is explicit that a malicious `owner` is **not** defended against — that role
can enable screenshots, widen retention and read everything, because that is the role's purpose.
What the design offers instead is accountability, and accountability made of rows an administrator
can quietly edit is not accountability. This grant is what makes the difference between "we keep a
log" and "the log cannot be doctored by anyone operating the system".

If you genuinely need to modify `audit_log` — a legal hold, a court-ordered erasure — that requires
the RDS master user, is outside every application path, and should be recorded outside this system
as a deliberate act. **Treat needing it as an incident in its own right.**

### Verifying the grant is still in force

Worth doing after any migration that touches roles. As the master user:

```sql
select privilege_type from information_schema.role_table_grants where grantee = 'worklens_app' and table_name = 'audit_log';
```

Two rows, `SELECT` and `INSERT`. Anything else means a later migration widened it — `0003` also sets
default privileges for future tables created by the migrator to full DML, so a table *recreated*
under that default would come back writable.

---

## 13. Quick reference

| Task | Command |
|---|---|
| Apply migrations | `aws lambda invoke --region ap-south-1 --cli-binary-format raw-in-base64-out --function-name worklens-prod-db-migrate --payload '{}' /dev/stdout` |
| Re-run aggregation, one org, explicit range | see §5 |
| Retention dry run | `--function-name worklens-prod-retention-sweeper --payload '{"source":"manual","dry_run":true}'` |
| Sweep nonces now | `--function-name worklens-prod-nonce-sweeper --payload '{"source":"manual"}'` |
| Check the DLQ | `aws sqs get-queue-attributes --queue-url "$(terraform -chdir=infra output -raw schedule_dead_letter_queue_url)" --attribute-names ApproximateNumberOfMessages` |
| Tail a function | `aws logs tail /aws/lambda/worklens-prod-<key> --region ap-south-1 --follow` |
| Find a request id | §4 |
| List alarms | `terraform -chdir=infra output alarm_names` |
| Alarm state | `aws cloudwatch describe-alarms --region ap-south-1 --alarm-name-prefix worklens-prod --query 'MetricAlarms[?StateValue!=`OK`].[AlarmName,StateValue,StateReason]' --output table` |
| Diagnose a device | `worklens-agentctl doctor` on the laptop |
| Preview the employee notice | `worklens-agentctl notice` |

---

## 14. Operational gaps found while writing this document

These were found by reading the code paths a runbook has to describe. None is fixed here — this is
a documentation phase — and each is stated with enough detail to fix.

### 14.1 The device root key secret's shape is rejected by the code that reads it

**This stops device enrolment working on a first deploy.**

`infra/modules/observability/main.tf` writes:

```hcl
secret_string = jsonencode({
    current_key_version = 1
    keys = {
      "1" = base64encode(random_password.device_root_key.result)
    }
})
```

`parseRootKeys` in `backend/src/shared/deviceSecret.ts` expects a **flat** map of version to key and
rejects any non-numeric key outright:

```ts
for (const [version, value] of Object.entries(parsed as RootKeyMap)) {
    if (!/^\d+$/.test(version)) {
      throw new Error(`Device root key has a non-numeric version "${version}".`);
    }
```

Given the Terraform-produced JSON, the first entry is `current_key_version` and it throws. The
documented contract is in a comment directly above the Terraform (`Contract for
backend/src/shared/*: { "current_key_version": <int>, "keys": { ... } }`) and in
`infra/modules/observability/README.md`, so the *intent* is the nested shape and the *implementation*
is the flat one.

Every device route derives a secret, so the symptom is that enrolment and all signed agent requests
fail with a 500 from the first invocation onward. It is not caught by any test:
`backend/test/shared/deviceSecret.test.ts` injects a `Map` through `setRootKeysForTest` and never
exercises `parseRootKeys` against the JSON Terraform actually writes.

Two possible fixes — teach `parseRootKeys` the nested shape (and use `current_key_version` instead
of `Math.max`), or change the Terraform to emit the flat map. The first honours the documented
contract and gives rotation an explicit "current" pointer rather than inferring it. Whichever is
chosen, the fix needs a test that parses a string built the same way Terraform builds it.

Until it is fixed, §10 describes the flat shape, because that is what the running code parses.

### 14.2 `POST /v1/aggregation/run` cannot work as wired

`infra/modules/api/main.tf` routes it at `aggregate-timesheets` through an `AWS_PROXY` integration
with the Cognito authorizer. But `backend/src/handlers/jobs/aggregateTimesheets.ts` exports a bare
event handler:

```ts
export async function handler(event: AggregateEvent = {}): Promise<AggregateResponse>
```

`backend/functions.json` points the Lambda handler at `index.handler`, so that is the function API
Gateway invokes. Three things follow:

1. **The response has no `statusCode`**, so a proxy integration returns 502 to the caller even when
   the aggregation succeeds.
2. **The request body is never read.** The handler receives the API Gateway event, whose `org_id`,
   `from`, `to` and `lookback_days` are all undefined — so a call intended to aggregate one
   organisation over one range instead aggregates **every organisation** over the default three-day
   lookback.
3. **There is no role check.** `backend/src/handlers/dashboard/reporting.ts` and
   `backend/src/middleware/cognitoAuth.ts` both document that this route uses `withCognitoAuth` to
   get "the same authentication, the same role check and the same D7 gate as every other one", and
   `infra/modules/api/README.md` says it "is authorised inside `aggregate-timesheets`". Grepping for
   `withCognitoAuth` finds the definition and those two comments — **no call site**. The gateway
   authorizer means only an authenticated pool user can reach it, but any role, including
   `employee`, and without MFA.

The fix is a second exported handler in `aggregateTimesheets.ts` wrapped in
`withHandler` + `withCognitoAuth(POLICY.ownerWrite, ...)` that parses the body into an
`AggregateEvent`, and a `functions.json` entry pointing the route at it. §5 uses direct Lambda
invocation instead, which is unaffected.

### 14.3 `AGGREGATION_LOOKBACK_DAYS` is not set on the function

`infra/modules/lambda/main.tf` sets `NONCE_RETENTION_SECONDS`, `HMAC_TIMESTAMP_SKEW_SECONDS`,
`PRESIGN_EXPIRY_SECONDS` and the rest, but never `AGGREGATION_LOOKBACK_DAYS`. The scheduled run is
unaffected because the EventBridge target passes `lookback_days` explicitly from
`var.aggregation_lookback_days`.

The gap shows up on a manual invoke with no `lookback_days`: it falls back to the code default in
`backend/src/shared/config.ts`, which is 3. The two agree today only because both defaults are 3. A
deployer who sets `aggregation_lookback_days = 7` in `terraform.tfvars` gets 7 from the schedule and
**3** from every manual invoke, with nothing to indicate the discrepancy. Add it to the aggregation
function's environment.

### 14.4 The `next_steps` output prints a command that fails on AWS CLI v2

`infra/outputs.tf` prints:

```
aws lambda invoke --region ... --function-name ... --payload '{}' /dev/stdout
```

CLI v2 base64-decodes `--payload` by default, so this fails with an `Invalid base64` error on the
very first step a deployer takes after a successful apply. Add
`--cli-binary-format raw-in-base64-out`.

### 14.5 The `alarms` module README describes an input the root stack does not pass

`infra/modules/alarms/README.md` warns that `rds_allocated_storage_gb` "is fed from a variable, not
from the database module", and that the threshold therefore goes stale after storage autoscaling.
`infra/main.tf` actually passes `module.database.allocated_storage` — the instance's current
allocation — with a comment explaining exactly why. The code is right and the README's gotcha is
stale.

Worth correcting because it is the kind of note that gets acted on: somebody reading it might
"fix" the wiring to use the variable and reintroduce the problem the comment prevents. The residual
truth is smaller: the value is read at plan time, so the threshold only catches up with an
autoscaled volume at the next `apply`.

### 14.6 Two smaller notes

- **Screenshot deletes are not version-aware** (§8). Not a defect exactly — it is recorded in
  `infra/modules/storage/README.md` — but it means "hard delete" is accurate about the application
  and approximate about storage for up to seven days. If DPDP erasure has to be provably immediate,
  this is where it is not.
- **`docs/DEPLOYMENT.md` does not exist yet**, and both `infra/outputs.tf`'s `next_steps` and this
  document's neighbours refer to it. It is Phase 7.3 alongside this file.
