# `scheduling`

Owns the three EventBridge cron rules that drive background work — nightly timesheet aggregation, daily retention enforcement, hourly replay-nonce expiry — together with their Lambda targets, the fixed JSON input each job is invoked with, the `lambda:InvokeFunction` permissions scoped to each rule, a shared dead-letter queue with a policy restricting it to these rules, and a CloudWatch alarm that fires when anything lands in that queue.

## Design notes

**Three rules, three unrelated reasons, deliberately not merged.** The header comment sets out the distinction and it is worth preserving. Aggregation is a data-derivation job. Retention *deletes personal data* on a schedule an owner configures, and is separately auditable for exactly that reason. Nonce expiry is replay-protection bookkeeping whose interval is a function of the accepted HMAC timestamp window, not of anything in `monitoring_config`. Folding the nonce sweep into the retention sweep would mean that shortening a retention window — a data-policy decision made in the dashboard — silently changed how long a replayed request stays detectable. A security control's cadence should not be a side effect of a config field.

**Aggregation looks back three days, not one, and the reason is the offline agent.** An agent on a train uploads yesterday's events today; if the nightly run only recomputed yesterday, that late data would never reach a timesheet. Recomputing a settled day is free because aggregation is an idempotent upsert on `(org_id, employee_id, work_date)`, so the lookback costs a little compute and buys correctness for every device that was offline. The variable is validated to 1–31.

**Cron is UTC and the default is tuned for India.** EventBridge cron expressions have no timezone, so `cron(45 20 * * ? *)` is 02:15 IST — after the end of an Indian working day and before anyone opens a dashboard the next morning, which matches the plan's target jurisdiction. The variable description is explicit that this only decides *when the work happens*: day boundaries themselves are computed per employee in the employee's own timezone inside the job, so changing this expression does not change how days are cut.

**Retention runs after aggregation, on purpose.** 22:00 UTC against aggregation's 20:45. The variable description states the ordering constraint: aggregation must have finished turning yesterday's events into timesheets before retention is allowed to delete those events. Get the order wrong and retention deletes the raw events that a not-yet-run aggregation needed, and the timesheet for that day is permanently thin.

**`retention_max_deletions_per_run` bounds a delete that could otherwise not finish.** A first run against a long backlog, or a run right after someone shortens the retention window sharply, could be an unbounded delete that hits the function's 300-second timeout halfway through. Capping it means each run makes bounded progress and the next one continues. The validation floor of 1000 exists so the cap cannot be set so low that retention never catches up with incoming data.

**`aws_cloudwatch_event_rule`, not EventBridge Scheduler.** The header records the reasoning: three fixed cron rules with no need for flexible time windows, per-schedule IAM roles, or schedule groups. One resource per schedule, no extra role to maintain.

**`target_id` is stable, not generated.** Left to the provider it would be a random suffix that churns the plan on every unrelated change. Naming it `${name_prefix}-${key}` keeps diffs meaningful.

**The retry policy is two hours, then give up.** `maximum_event_age_in_seconds = 7200` with three attempts, and the comment explains the choice: two hours covers a transient RDS failover or a Lambda throttle, and beyond that the run is stale enough that the next scheduled invocation is a better recovery path than a very old retry.

**The dead-letter queue exists so a missing night is not silent.** Without it, an invocation that exhausts its retries simply vanishes and a night of timesheets is absent with nothing to point at. The queue retains the failed event for up to 14 days, and the alarm makes it visible immediately. The alarm description is written as an operator note — it names the likely cause, the user-visible symptom, and the two ways to recover (wait for the next schedule, or `POST /v1/aggregation/run`).

**The DLQ policy is scoped to this module's rules by ARN.** `ArnEquals` against the list of rule ARNs, so the queue cannot be used as a drop box by any other EventBridge rule in the account, plus a blanket `Deny` on `aws:SecureTransport = false`. Encryption is `sqs_managed_sse_enabled` rather than a CMK; the messages are the scheduler's own input JSON (`source`, `lookback_days`, `max_deletions_per_run`) and carry no employee data.

**`treat_missing_data = "notBreaching"` is required for this alarm to work.** An empty SQS queue publishes no datapoints rather than a zero, so the default treatment would hold the alarm in `INSUFFICIENT_DATA` forever and it would never transition to `OK` — meaning you could not tell "healthy" from "alarm not wired up". `ok_actions` is also set, so recovery is notified, not just failure.

**`enabled` is a first-apply convenience.** Standing the stack up before migrations have run and before any device has enrolled means an aggregation run against an empty schema — noise, not signal. The variable sets rule `state` to `DISABLED` rather than removing the rules, so enabling them later is a one-line change.

## Inputs

| Name | Type | Default | Description |
|---|---|---|---|
| `name_prefix` | `string` | required | Prefix applied to every resource name, e.g. `worklens-prod`. |
| `tags` | `map(string)` | `{}` | Tags applied to every taggable resource in this module. |
| `enabled` | `bool` | `true` | Whether the schedules are `ENABLED`. Set `false` to stand the stack up without any background job firing — useful on a first apply, before migrations have run and before any device has enrolled, because an aggregation run against an empty schema is noise in the logs rather than a signal. |
| `aggregate_timesheets_function_arn` | `string` | required | ARN of the aggregation Lambda. |
| `aggregate_timesheets_function_name` | `string` | required | Name of the aggregation Lambda, for the invoke permission. |
| `retention_sweeper_function_arn` | `string` | required | ARN of the retention sweeper Lambda. |
| `retention_sweeper_function_name` | `string` | required | Name of the retention sweeper Lambda, for the invoke permission. |
| `nonce_sweeper_function_arn` | `string` | required | ARN of the replay-nonce sweeper Lambda. |
| `nonce_sweeper_function_name` | `string` | required | Name of the replay-nonce sweeper Lambda, for the invoke permission. |
| `aggregation_schedule_expression` | `string` | `"cron(45 20 * * ? *)"` | When the nightly aggregation runs. EventBridge cron is always UTC; the default is 02:15 IST. Change it if the workforce is in another timezone; per-employee day boundaries are handled inside the job regardless, so this only decides when the work happens, not how days are cut. Validated as a `cron(...)`/`rate(...)` expression. |
| `retention_schedule_expression` | `string` | `"cron(0 22 * * ? *)"` | When retention enforcement runs. Deliberately offset from aggregation so the two are never deleting and reading the same rows at once: aggregation should have finished turning yesterday's events into timesheets before retention deletes anything. Validated as a `cron(...)`/`rate(...)` expression. |
| `nonce_sweep_schedule_expression` | `string` | `"rate(1 hour)"` | How often replay-protection nonces are expired. Hourly keeps `device_nonces` small. The retention interval used by the sweeper itself must stay comfortably larger than the accepted request timestamp window, or a replay becomes possible at the window boundary. Validated as a `cron(...)`/`rate(...)` expression. |
| `aggregation_lookback_days` | `number` | `3` | How many days back a scheduled aggregation run recomputes. More than one on purpose: an agent that was offline overnight uploads yesterday's events today, and that late data has to be folded into the correct day's timesheet. Aggregation is an idempotent upsert, so recomputing a settled day is free. Validated to 1–31. |
| `retention_max_deletions_per_run` | `number` | `200000` | Ceiling on rows deleted in one retention run. Bounds a first run against a long backlog, or a run after someone shortens the retention window sharply, so it cannot become an unbounded delete that times out halfway through. The next scheduled run continues where this one stopped. Validated to be at least 1000. |
| `maximum_event_age_in_seconds` | `number` | `7200` | How long EventBridge keeps retrying a failed invocation before dead-lettering it. Validated to 60–86400. |
| `maximum_retry_attempts` | `number` | `3` | Retry attempts before an invocation is dead-lettered. Validated to 0–185. |
| `dlq_retention_seconds` | `number` | `1209600` | How long a dead-lettered invocation is retained for inspection. 14 days is the SQS maximum. Validated to 60–1209600. |
| `alarm_topic_arn` | `string` | `null` | SNS topic notified when a scheduled job dead-letters. `null` disables the alarm. |

## Outputs

| Name | Description |
|---|---|
| `rule_names` | Map of logical schedule name to EventBridge rule name. |
| `rule_arns` | Map of logical schedule name to EventBridge rule ARN. |
| `schedule_expressions` | The cron or rate expression in force for each schedule, for the deploy summary. |
| `enabled` | Whether the schedules are currently enabled. |
| `dead_letter_queue_arn` | ARN of the queue that receives invocations which exhausted their retries. |
| `dead_letter_queue_url` | URL of the dead-letter queue, for inspecting failed runs with the AWS CLI. |
| `dead_letter_queue_name` | Name of the dead-letter queue, as used in the CloudWatch alarm dimension. |

## Security notes

Against `docs/PLAN.md` §6:

- **Row 11 — configurable retention and working hard delete.** This module is what makes the nightly `retention-sweeper` actually run, and `retention_max_deletions_per_run` is what stops a large sweep from timing out mid-delete and leaving retention permanently behind.
- **Row 6 (D3 replay protection).** The hourly nonce sweep is the maintenance half of replay rejection: without it `device_nonces` grows without bound, and the interval is set here rather than being inherited from a data-policy field.
- **Beyond the checklist.** Each `aws_lambda_permission` is scoped by `source_arn` to its own rule, so one rule cannot invoke another job's function. The DLQ policy restricts `sqs:SendMessage` to these three rule ARNs and denies non-TLS access outright. The DLQ carries SQS-managed encryption; its contents are scheduler input JSON, not employee data.

## Gotchas / operational notes

- **`enabled = false` stops retention as well as aggregation.** That is a data-protection consequence, not just an operational one: with the schedules disabled, events and screenshots stay past their configured retention window indefinitely. The S3 lifecycle rule in the `storage` module still expires screenshot objects, but nothing removes database rows. Do not leave it disabled after a first apply.
- **The schedule expressions must stay in this order: aggregation, then retention.** Nothing in Terraform enforces it. Moving retention earlier than aggregation means events can be deleted before they have been rolled into a timesheet, and the resulting timesheet gap is unrecoverable.
- **A dead-lettered invocation is not replayed automatically.** There is no redrive back to Lambda. The DLQ retains the event so you can see *that* a run failed and with what input; recovery is either the next schedule (aggregation, thanks to `aggregation_lookback_days`) or an explicit `POST /v1/aggregation/run`. For retention, the next daily run picks up the backlog.
- **The DLQ alarm is silently absent if `alarm_topic_arn` is null.** `count = var.alarm_topic_arn == null ? 0 : 1` — no alarm, no error, and the whole point of the queue is lost because nothing tells you it has messages.
- **The queue is shared across all three schedules.** A message in it tells you *something* failed; you have to read the message body to know which job. The alarm text assumes aggregation as the most likely case.
- **`aggregation_lookback_days` and the retention window interact.** A lookback longer than `retention_days_events` means the run reaches back past data that has already been deleted — harmless, but the recomputed timesheets for those days will be based on whatever survives, which is not the same numbers as the original run.
- **`rate(1 hour)` counts from when the rule was created**, not from the top of the hour. Do not expect the nonce sweep at :00.
- **Cron expressions are UTC with no DST handling.** A workforce in a DST-observing timezone drifts an hour relative to the intended local time twice a year. The plan's target region does not observe DST, which is why this has not been solved rather than a claim that it does not matter.
- **The nonce sweep interval and the HMAC window are coupled but not validated together.** The sweeper's retention (`nonce_retention_seconds` in `modules/lambda`, default 600) must stay comfortably above `hmac_timestamp_skew_seconds` (default 300). Nothing in either module checks the relationship, and getting it wrong reopens a replay window rather than producing an error.
- **Changing a schedule's logical key replaces the rule, the target, the permission and the alarm dimension.** The three keys are the map keys in `local.schedules`; they are also embedded in resource names.
- **`retention_max_deletions_per_run` is passed as job input, so a change needs no Lambda redeploy** — but it also means the running value is in the EventBridge target, not in the function's environment. Reading the function config will not tell you what it is; read the rule's target input.
