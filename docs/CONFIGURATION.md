# Configuration

Every knob in WorkLens, where it lives, what it defaults to, and why the default is what it is.

This document is a reference, so most of it is tables. The prose is reserved for the places where
a value's default encodes a decision rather than a preference — which, in a monitoring product, is
most of the interesting ones.

It is derived from the code, not from the other documents: the tables were built by reading
`infra/variables.tf` and every `variables.tf` under `infra/modules/`, `backend/src/shared/config.ts`,
`dashboard/src/lib/env.ts`, `agent/internal/config/config.go`, and the DDL in
`backend/migrations/0001_init.sql`. Where a `.env.example` file and the code that reads it disagree,
§9 says so rather than papering over it.

**No value in this document is a secret, and nothing here asks you for one.** §8 explains what the
two genuine secrets are and why neither is ever a configuration value you type.

---

## 1. Deploy-time and runtime are different things

This is the distinction to get straight before reading anything else, because conflating the two is
the most likely source of confusion in the whole system. There are four configuration surfaces, and
they differ in *who* sets them, *when* the change takes effect, and *what happens if you get one
wrong*.

| Surface | Where it is set | Who sets it | When a change takes effect | What it controls |
|---|---|---|---|---|
| **Terraform variables** | `infra/terraform.tfvars` | Whoever owns the AWS account | On the next `terraform apply` | The shape of the infrastructure: region, instance sizes, retention ceilings, rate limits, alarm routing |
| **Backend environment** | Lambda environment variables, written by `infra/modules/lambda` | Terraform, from the variables above | On the next `apply` (a new function version) | Limits and endpoints the handlers enforce: batch sizes, quotas, presign TTLs, log level |
| **Dashboard environment** | `dashboard/.env.local`, or the hosting platform's environment | Whoever deploys the dashboard | At the dashboard's next **build** — `NEXT_PUBLIC_*` values are inlined | Where the dashboard finds the API and the login page |
| **Per-organisation monitoring config** | The `monitoring_config` row, edited at `/settings/monitoring` in the dashboard | The organisation's **owner**, in the UI | Within one config poll — 15 minutes by default — with no deploy and no restart | What the agent is permitted to collect from employees' laptops |

The first three are **deploy-time**. They are an operator's business, they live in files, and changing
one means running something.

The fourth is **runtime**, and it is the one that matters to the people being monitored. Turning
screenshots off is not a deploy. It is a form submission by an owner, audited in `audit_log`, which
bumps `config_version`; every agent notices the bump on its next poll of `GET /v1/device/config` and
reloads. That asymmetry is deliberate — the setting most likely to be changed in a hurry is one that
turns capture *off*, and that must not wait on a release.

The agent has a fifth, smaller surface: a local `config.json` holding machine-level facts like the API
URL. It deliberately holds **nothing** about what is collected. See §7.

### The one place the two surfaces meet, and how to keep them straight

Retention exists in both, and the relationship is easy to invert:

- `monitoring_config.retention_days_screenshots` (runtime, per organisation) is the **policy**. The
  nightly retention sweeper enforces it, deleting the S3 object before the row that points at it.
- `screenshot_retention_days` (Terraform) is an **S3 lifecycle backstop**. It is the second line of
  defence for the case where the sweeper has not run.

Keep the Terraform value at or above the longest window any organisation on the deployment will
configure. Set it lower and the lifecycle rule deletes images the application still believes it
holds — a retention report that says one thing and a bucket that says another.

---

## 2. Terraform variables — the infrastructure

`infra/terraform.tfvars.example` is committed; copy it and edit:

```bash
cp infra/terraform.tfvars.example infra/terraform.tfvars
```

Every root variable has a working default, so `terraform apply` with no tfvars at all produces a
functioning stack. Three values should nonetheless be set before you call it production; §10 lists
them.

### 2.1 Placement and naming

| Variable | Type | Default | What it does |
|---|---|---|---|
| `aws_region` | string | `ap-south-1` | Region for every resource. Mumbai because India's DPDP Act is the target jurisdiction and employee data staying in-country is the easiest data-localisation position to defend. |
| `project` | string | `worklens` | Used in resource names and the `Project` tag. Validated as lowercase alphanumeric with hyphens, 2–21 chars, starting with a letter. |
| `environment` | string | `prod` | Part of every resource name, so prod and staging coexist in one account. Validated as lowercase alphanumeric with hyphens, 2–16 chars, starting with a letter. |
| `extra_tags` | map(string) | `{}` | Merged into the default tag set on every resource. Useful for cost allocation. |

Resource names are `${project}-${environment}` plus a per-resource suffix. Globally unique names
(both S3 buckets, the Cognito hosted-UI domain) additionally carry a 4-byte random suffix generated
once and kept in state, so a first apply cannot collide with any other WorkLens deployment.

### 2.2 Network

| Variable | Type | Default | What it does |
|---|---|---|---|
| `vpc_cidr` | string | `10.42.0.0/20` | CIDR for the VPC. A /20 gives room for four /22 subnets across two AZs. Validated as a real IPv4 CIDR. |
| `enable_vpc_flow_logs` | bool | `true` | Flow logs to CloudWatch. On by default: this VPC carries employee activity data, and "did anything talk to the database that should not have" is worth about a dollar a month to be able to answer after the fact. |

There is no NAT gateway (deviation D6). Egress from the private subnets is a free S3 gateway endpoint
plus two interface endpoints — Secrets Manager for the device root key, and `cognito-idp` for the
pre-token trigger's `AdminGetUser` call.

### 2.3 Database

| Variable | Type | Default | What it does |
|---|---|---|---|
| `db_instance_class` | string | `db.t4g.micro` | Sized for a single company up to a few hundred devices: ingest is one batched write per device per minute, not a per-request workload. Scale the class before reaching for RDS Proxy. |
| `db_allocated_storage` | number | `20` | Initial storage in GB. Validated `>= 20`, the gp3 minimum. |
| `db_max_allocated_storage` | number | `100` | Storage autoscaling ceiling in GB. Zero disables autoscaling. |
| `db_multi_az` | bool | `false` | Off because it roughly doubles the database bill and this workload tolerates minutes of write unavailability — agents buffer locally and retry, so a failover costs no data. Turn it on if the dashboard must stay reachable through an AZ failure. |
| `db_backup_retention_days` | number | `7` | Automated backup retention. Non-zero also enables point-in-time recovery. Root validation accepts 1–35; see §9 for why values below 7 still fail. |
| `db_deletion_protection` | bool | `true` | Stops `terraform destroy` taking the database with it. Turning it off is a deliberate act, which is exactly the friction it exists to provide. |
| `cognito_deletion_protection` | bool | `true` | Separate from the database flag on purpose: losing the pool means recreating every dashboard account and re-enrolling every MFA factor, a different kind of loss that should not be switched off as a side effect of tearing down a database. |

### 2.4 Storage and retention

| Variable | Type | Default | What it does |
|---|---|---|---|
| `screenshot_retention_days` | number | `90` | S3 lifecycle expiry for screenshot objects. A **backstop**, not the policy — see §1. Keep at or above the longest `retention_days_screenshots` any organisation will configure. |
| `cloudtrail_retention_days` | number | `365` | Lifecycle expiry for CloudTrail objects. Longer than application logs because a trail's value is retrospective. |
| `log_retention_days` | number | `30` | CloudWatch retention for Lambda, API Gateway, WAF, VPC flow logs and the exported Postgres logs. Deliberately short: application logs can contain window titles, which are personal data. Long enough to debug an incident, not long enough to become a second copy of the activity database. Validated against the set CloudWatch Logs accepts. |

### 2.5 Dashboard and authentication

| Variable | Type | Default | What it does |
|---|---|---|---|
| `dashboard_origins` | list(string) | `["http://localhost:3000"]` | Drives three things at once: the API's CORS allowlist, the S3 CORS rule for presigned reads, and the Cognito callback (`<origin>/api/auth/callback`) and logout (`<origin>/login`) URLs. Validated non-empty, each entry scheme-qualified with no trailing path. **The default is a production risk — see §10.** |
| `cognito_domain_prefix` | string | `null` | Hosted-UI domain prefix, which must be unique across the region. Null derives `${project}-${environment}-${suffix}`, which is what lets a first apply succeed without guessing an unused name. |
| `cognito_advanced_security_mode` | string | `AUDIT` | `OFF`, `AUDIT` or `ENFORCED`. AUDIT records risk signals (impossible travel, credential stuffing) without blocking. This pool holds accounts that can read every employee's activity, so the signals are worth having — while ENFORCED can lock out a legitimate owner who is simply travelling. |

Pool MFA is `OPTIONAL`, not `REQUIRED`, and that is deviation D7 rather than an oversight: forcing
TOTP on an employee who only wants to see their own timesheet is the wrong trade. Admin MFA is
enforced server-side instead — the pre-token trigger injects a `wl:mfa` claim and the API refuses
admin-scoped routes without it. There is no Terraform variable that relaxes this.

### 2.6 API

| Variable | Type | Default | What it does |
|---|---|---|---|
| `api_stage_name` | string | `v1` | Stage name, which is also the first path segment, making the base URL `.../v1`. |
| `api_throttle_rate_limit` | number | `200` | Steady-state requests per second for the stage, across all callers. |
| `api_throttle_burst_limit` | number | `400` | Burst capacity. Above the rate limit so a fleet-wide sync after an outage is absorbed rather than throttled. |
| `api_custom_domain_name` | string | `null` | Optional custom domain. Null uses the `execute-api` hostname. |
| `api_acm_certificate_arn` | string | `null` | Regional ACM certificate for the above. A cross-variable validation makes it required whenever `api_custom_domain_name` is set. Must be regional, in `aws_region` — a us-east-1 certificate is for CloudFront and will not attach. |
| `api_data_trace_enabled` | bool | `false` | Full request/response logging. **Must stay false.** Request bodies contain window and page titles, so enabling this copies personal data into CloudWatch under a different retention policy than the database. The `api` module carries a validation that rejects `true` outright, so this cannot be turned on by editing one file. |

### 2.7 WAF

| Variable | Type | Default | What it does |
|---|---|---|---|
| `waf_rate_limit_per_five_minutes` | number | `2000` | Rate-based limit per source IP. Generous because an entire office can share one NAT address: 50 devices heartbeating and uploading from one IP is normal traffic, not an attack. Validated `>= 100`, the AWS minimum. |
| `waf_enroll_rate_limit_per_five_minutes` | number | `100` | Tighter limit on `/v1/device/enroll`. Enrolment is the one route with no HMAC credential yet — the agent has no secret at that point — so its only other protection is token single-use. Onboarding a whole office at once is dozens of calls, not hundreds. |
| `waf_count_only` | bool | `false` | Puts the AWS managed rule sets in count mode. Worth a week after go-live to see what *would* have been blocked before it blocks a real agent, then turn off. |

### 2.8 Lambda

| Variable | Type | Default | What it does |
|---|---|---|---|
| `lambda_artifact_dir` | string | `../backend/artifacts` | Directory of deployment zips, relative to `infra/`. Produced by `make backend-build` from `backend/functions.json` — the same inventory the module declares from, so build and deploy cannot drift. A root-level `check` block fails the *plan* naming any missing zip, rather than failing the apply halfway through creating the stack. |
| `ingest_reserved_concurrency` | number | `20` | A **database protection, not a cost control**: each warm container holds a Postgres connection and `db.t4g.micro` allows roughly 85, so capping ingest means a fleet-wide retry storm queues at Lambda instead of exhausting connections and taking the dashboard down with it. Agents receive 429 and back off. `-1` removes the reservation. |
| `lambda_log_level` | string | `info` | `LOG_LEVEL` for every function: `debug`, `info`, `warn` or `error`. |
| `create_db_migrate_function` | bool | `true` | Keep it. RDS is not publicly reachable and there is no NAT gateway, so this in-VPC function is the only way to apply migrations without standing up a bastion. |
| `hmac_timestamp_skew_seconds` | number | `300` | Accepted clock skew for HMAC-signed agent requests. Validated 30–900, and must stay comfortably below the nonce retention interval or a replay becomes possible at the window boundary — the backend refuses to start if that ordering is violated (§4.3). |

### 2.9 Scheduling

| Variable | Type | Default | What it does |
|---|---|---|---|
| `enable_schedules` | bool | `true` | Whether the background jobs run. Set false for a first apply, before migrations have been applied and before any device has enrolled: an aggregation run against an empty schema is log noise, not a signal. |
| `aggregation_schedule_expression` | string | `cron(45 20 * * ? *)` | EventBridge cron, always UTC. 20:45 UTC is 02:15 IST — after the end of an Indian working day, before anyone opens a dashboard. Per-employee day boundaries are computed in each employee's own timezone inside the job, so this only decides *when the work runs*, not how days are cut. |
| `aggregation_lookback_days` | number | `3` | Days recomputed per run. More than one on purpose: an agent offline overnight uploads yesterday's events today, and that late data has to land in the right day's timesheet. Aggregation is an idempotent upsert, so recomputing a settled day costs only CPU. |

### 2.10 Alerting and auditing

| Variable | Type | Default | What it does |
|---|---|---|---|
| `alarm_email` | string | `null` | Subscribed to the alarm SNS topic. Null creates the topic with no subscriber, so alarms fire into the void. Validated as an email address or null. AWS sends a confirmation email that must be accepted by hand. **Set this — see §10.** |
| `enable_cloudtrail_s3_data_events` | bool | `false` | Object-level reads and writes on the screenshot bucket, logged to CloudTrail. Off because data events are billed per event and the application's own `audit_log` already records who viewed which screenshot. Turn it on where an independent, application-external record of screenshot access is required. |

### 2.11 The bootstrap module — remote state

`infra/backend.tf` ships with the S3 backend commented out, because a fresh clone cannot use it: the
bucket does not exist yet and `terraform init` against a non-existent backend fails before it can
create anything. `infra/bootstrap` is a separate root module that creates the bucket and lock table
with its own local state.

```bash
terraform -chdir=infra/bootstrap apply
```

Then uncomment the backend block, paste the two printed names, and migrate:

```bash
terraform -chdir=infra init -migrate-state
```

| Variable | Type | Default | What it does |
|---|---|---|---|
| `aws_region` | string | `ap-south-1` | Region for the state bucket and lock table. Must match the region in the root module's backend block. |
| `project` | string | `worklens` | Used to build the bucket and table names. |
| `state_bucket_name` | string | `null` | Null appends a random suffix, since S3 names are global and a fixed name would collide with any other WorkLens deployment. |
| `lock_table_name` | string | `null` | DynamoDB table holding state locks. The lock is what stops a second apply — a colleague, or CI — running against half-applied state, a failure mode that is silent and expensive. |
| `noncurrent_version_retention_days` | number | `90` | How long superseded state versions are kept. Deliberately generous: this is the recovery window for a corrupted or truncated state file, which is the whole reason versioning is on, and 90 days of state history costs cents. Validated `>= 7`. |

### 2.12 Module inputs not exposed at the root

Each module has its own variables. Most are **wiring** — ARNs, names and ids the root module passes
between modules — and are not deployer-facing. The rest are tunables the root either hard-codes or
leaves on the module default, which means changing them requires editing `infra/main.tf` or the
module, not a tfvars file. Both kinds are listed, because a variable that exists and cannot be
reached from tfvars is exactly the kind of thing that is otherwise discovered by grep at an
inconvenient moment.

Two module defaults are **shadowed** by the root and never take effect: `network.vpc_cidr`
(`10.30.0.0/16`) and `auth.advanced_security_mode` (`OFF`). A third,
`storage.screenshot_retention_days` (`30`), is likewise overridden by the root's `90`. Read the root
default as the real one in all three cases.

Every module also takes `name_prefix` (string, no default) and `tags` (map(string)) from the root;
those two rows are omitted from the tables below rather than repeated eleven times.

#### `modules/network`

| Variable | Default | Root passes | Notes |
|---|---|---|---|
| `vpc_cidr` | `10.30.0.0/16` | `var.vpc_cidr` | Module default shadowed. |
| `availability_zone_count` | `2` | hard-coded `2` | Validated 2–3. RDS needs a subnet group spanning two AZs. |
| `interface_endpoint_subnet_count` | `1` | not passed | ENIs per interface endpoint, ~$7.30/month each. `2` removes the single-AZ dependency at roughly double the cost. |
| `enable_cognito_vpc_endpoint` | `true` | hard-coded `true` | Required for the in-VPC `admin-api` to manage dashboard users, because there is no NAT gateway. Disable only if dashboard users are created out-of-band. |
| `flow_log_retention_days` | `30` | `var.log_retention_days` | |
| `logs_kms_key_arn` | — | wired from `observability` | CMK for the flow log group. |
| `enable_flow_logs` | `true` | `var.enable_vpc_flow_logs` | Logs both REJECT and ACCEPT. |
| `database_port` | `5432` | hard-coded `5432` | Scopes the Lambda→RDS security group rules. |

#### `modules/database`

| Variable | Default | Root passes | Notes |
|---|---|---|---|
| `subnet_ids` | — | wired from `network` | Validated as spanning at least two AZs. |
| `vpc_security_group_ids` | — | wired from `network` | Should be the RDS SG only. |
| `kms_key_arn` | — | wired from `observability` | Storage encryption, backups, and the managed master secret. |
| `logs_kms_key_arn` | — | wired from `observability` | Encrypts the pre-created Postgres log group. |
| `engine_version` | `16` | not passed | A bare major version tracks the latest supported minor. |
| `parameter_group_family` | `postgres16` | not passed | Must match the major engine version. |
| `instance_class` | `db.t4g.micro` | `var.db_instance_class` | |
| `allocated_storage` | `20` | `var.db_allocated_storage` | |
| `max_allocated_storage` | `100` | `var.db_max_allocated_storage` | Equal to `allocated_storage` disables autoscaling. |
| `storage_type` | `gp3` | not passed | |
| `db_name` | `worklens` | not passed | The initial database created on the instance. |
| `master_username` | `wl_admin` | not passed | Its password is generated and rotated by RDS in Secrets Manager, never handled by Terraform. |
| `app_db_username` | `worklens_app` | not passed | The role the Lambdas authenticate as with IAM auth. Created by a migration (`GRANT rds_iam`), not by Terraform, because Terraform holds no database connection. |
| `database_port` | `5432` | hard-coded `5432` | |
| `backup_retention_period` | `7` | `var.db_backup_retention_days` | Validated `>= 7` here. |
| `backup_window` | `18:00-19:00` | not passed | Daily, UTC. |
| `maintenance_window` | `sun:19:30-sun:20:30` | not passed | Weekly, UTC. |
| `multi_az` | `false` | `var.db_multi_az` | |
| `deletion_protection` | `true` | `var.db_deletion_protection` | |
| `apply_immediately` | `false` | not passed | Modifications wait for the maintenance window. |
| `log_retention_days` | `30` | `var.log_retention_days` | |
| `log_min_duration_statement_ms` | `1000` | not passed | Logs statements slower than this. `-1` disables. |
| `performance_insights_enabled` | `false` | not passed | Off by cost decision. |
| `auto_minor_version_upgrade` | `true` | not passed | Minor engine upgrades during the maintenance window. |

#### `modules/storage`

| Variable | Default | Root passes | Notes |
|---|---|---|---|
| `screenshot_bucket_name` | — | computed in root | `${prefix}-screenshots-${suffix}`. |
| `cloudtrail_bucket_name` | — | computed in root | `${prefix}-cloudtrail-${suffix}`. |
| `s3_kms_key_arn` | — | wired from `observability` | Default SSE-KMS for screenshot objects. |
| `s3_kms_key_id` | — | wired from `observability` | Used in the bucket policy that pins the allowed SSE key, so a presigned PUT cannot write an unencrypted object. |
| `logs_kms_key_arn` | — | wired from `observability` | Default SSE-KMS for the CloudTrail bucket. |
| `cloudtrail_arn` | — | computed in root | Passed as a deterministic string rather than read from the `observability` output, so the two modules do not form a dependency cycle. |
| `screenshot_retention_days` | `30` | `var.screenshot_retention_days` | Module default shadowed by the root's `90`. Validated `>= 1`. |
| `screenshot_noncurrent_version_days` | `7` | not passed | How long a superseded object version survives before permanent deletion. |
| `cloudtrail_retention_days` | `365` | `var.cloudtrail_retention_days` | |
| `cloudtrail_transition_days` | `90` | not passed | Days before trail objects move to STANDARD_IA. |
| `dashboard_origins` | — | `var.dashboard_origins` | CORS for the dashboard's presigned reads. |
| `agent_upload_origins` | `[]` | hard-coded `[]` | The Windows agent is not a browser and sends no `Origin` header, so it needs no CORS entry. Exists for browser-based test tools. |

#### `modules/auth`

| Variable | Default | Root passes | Notes |
|---|---|---|---|
| `domain_prefix` | — | computed in root | `coalesce(var.cognito_domain_prefix, "${prefix}-${suffix}")`. |
| `callback_urls` | — | derived in root | `<origin>/api/auth/callback` per origin. Validated non-empty. Cognito matches redirect URIs exactly, so a trailing-slash difference is a failed login. |
| `logout_urls` | — | derived in root | `<origin>/login` per origin. Validated non-empty. |
| `password_minimum_length` | `12` | not passed | Validated `>= 12`, so the floor cannot be lowered by passing a smaller number. Lower/upper/number/symbol are all required unconditionally in `main.tf`. |
| `temporary_password_validity_days` | `3` | not passed | How long an admin-created temporary password stays usable. |
| `advanced_security_mode` | `OFF` | `var.cognito_advanced_security_mode` | Module default shadowed by the root's `AUDIT`. |
| `deletion_protection` | `true` | `var.cognito_deletion_protection` | |
| `id_token_validity_minutes` | `60` | not passed | |
| `access_token_validity_minutes` | `60` | not passed | |
| `refresh_token_validity_days` | `30` | not passed | |
| `pre_token_generation_lambda_arn` | — | wired from `lambda` | The trigger that injects `wl:mfa`. |
| `pre_token_generation_lambda_function_name` | — | wired from `lambda` | For the invoke permission. |
| `pre_token_generation_role_name` | — | wired from `lambda` | This module attaches the trigger's `cognito-idp:AdminGetUser` policy, because the pool ARN is created here — doing it in `modules/lambda` would make the two mutually dependent. |
| `admin_api_role_name` | — | wired from `lambda` | `admin-api` manages dashboard users in this pool. |
| `group_precedence` | `{owner=1, manager=5, employee=10}` | not passed | Lower wins when a user is in several groups. |

#### `modules/api`

| Variable | Default | Root passes | Notes |
|---|---|---|---|
| `stage_name` | `v1` | `var.api_stage_name` | |
| `invoke_arns` | — | wired from `lambda` | Logical function key → invoke ARN. |
| `function_names` | — | wired from `lambda` | Logical function key → function name. |
| `cognito_user_pool_arn` | — | wired from `auth` | Backs the dashboard authorizer. |
| `log_kms_key_arn` | — | wired from `observability` | Encrypts access and execution log groups. |
| `log_retention_days` | `30` | `var.log_retention_days` | |
| `throttle_rate_limit` | `200` | `var.api_throttle_rate_limit` | |
| `throttle_burst_limit` | `400` | `var.api_throttle_burst_limit` | |
| `logging_level` | `INFO` | not passed | Execution log verbosity: `OFF`, `ERROR`, `INFO`. Distinct from `data_trace_enabled` — this logs *about* requests, not their bodies. |
| `data_trace_enabled` | `false` | `var.api_data_trace_enabled` | Carries a validation that rejects any value but `false`. |
| `metrics_enabled` | `true` | not passed | Per-method CloudWatch metrics. |
| `cors_allowed_origins` | — | `var.dashboard_origins` | **Validated to exactly one entry.** The preflight is an API Gateway MOCK integration, which can return only one static `Access-Control-Allow-Origin`; with several configured, every origin but the first would silently fail in a browser. Failing at plan time beats shipping a dashboard that works from one of the hostnames it was configured for. Supporting more means moving OPTIONS into a Lambda that echoes a checked `Origin`. |
| `minimum_compression_size` | `1024` | not passed | Compress responses above this size. `-1` disables. |
| `custom_domain_name` | `null` | `var.api_custom_domain_name` | |
| `acm_certificate_arn` | `null` | `var.api_acm_certificate_arn` | |
| `endpoint_type` | `REGIONAL` | not passed | REGIONAL is required to attach a WAF WebACL directly (deviation D2). |
| `manage_account_cloudwatch_role` | `true` | not passed | Creates the account-level API Gateway CloudWatch role. Required for access and execution logging to work at all, but it is a per-account, per-region setting — set false if another stack already manages it. |

#### `modules/waf`

| Variable | Default | Root passes | Notes |
|---|---|---|---|
| `api_stage_arn` | — | wired from `api` | The stage the WebACL is associated with. |
| `rate_limit_per_five_minutes` | `2000` | `var.waf_rate_limit_per_five_minutes` | Validated `>= 100`. |
| `enroll_rate_limit_per_five_minutes` | `100` | `var.waf_enroll_rate_limit_per_five_minutes` | Applied only to `/v1/device/enroll`. |
| `common_rule_set_count_only` | `false` | `var.waf_count_only` | |
| `common_rule_set_excluded_rules` | `["SizeRestrictions_BODY"]` | not passed | Excluded because an ingest batch of 500 events legitimately exceeds the 8 KB body size the managed rule flags. Removing this exclusion breaks normal agent traffic. |
| `known_bad_inputs_excluded_rules` | `[]` | not passed | |
| `log_retention_days` | `30` | `var.log_retention_days` | |
| `log_kms_key_arn` | — | wired from `observability` | |
| `enable_logging` | `true` | not passed | WebACL request logs to CloudWatch. |
| `log_only_blocked_and_counted` | `true` | not passed | Keeps CloudWatch cost proportional to attack traffic rather than to normal agent traffic. |

#### `modules/lambda`

| Variable | Default | Root passes | Notes |
|---|---|---|---|
| `environment` | — | `var.environment` | Exposed to handlers as `ENVIRONMENT`, which the backend uses to refuse body logging in prod. |
| `artifact_dir` | — | `var.lambda_artifact_dir` | Referenced with `filename`, so `terraform validate` succeeds before the zips exist; `apply` needs them. |
| `runtime` | `nodejs22.x` | hard-coded `nodejs22.x` | |
| `architecture` | `arm64` | hard-coded `arm64` | Graviton, ~20% cheaper per GB-second. |
| `log_retention_days` | `30` | `var.log_retention_days` | |
| `log_kms_key_arn` | — | wired from `observability` | |
| `log_level` | `INFO` | `var.lambda_log_level` | |
| `subnet_ids` | — | wired from `network` | Every function runs in the VPC, including the pre-token trigger — the claims it injects come from Postgres. |
| `security_group_ids` | — | wired from `network` | The Lambda SG. |
| `db_host` / `db_port` / `db_name` / `db_user` | — | wired from `database` | Become `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`. |
| `db_iam_auth_resource_arn` | — | wired from `database` | The `rds-db:connect` resource ARN for `db_user`. |
| `db_master_user_secret_arn` | — | wired from `database` | **Only the migration function may read it.** |
| `device_root_key_secret_arn` | — | wired from `observability` | |
| `rds_kms_key_arn` | — | wired from `observability` | Readers of Secrets Manager secrets need `kms:Decrypt` on it. |
| `screenshot_bucket_name` / `screenshot_bucket_arn` | — | wired from `storage` | |
| `screenshot_prefix` | `screenshots/` | wired from `storage` | IAM statements are scoped to it. |
| `s3_kms_key_arn` | — | wired from `observability` | Presigned PUTs must carry it in the SSE-KMS header. |
| `ingest_reserved_concurrency` | `20` | `var.ingest_reserved_concurrency` | |
| `hmac_timestamp_skew_seconds` | `300` | `var.hmac_timestamp_skew_seconds` | |
| `nonce_retention_seconds` | `600` | not passed | Sets `NONCE_RETENTION_SECONDS`. Must exceed the skew window or the backend refuses to start. Not exposed at the root, so changing it means editing `infra/main.tf`. |
| `max_events_per_batch` | `500` | not passed | Sets `MAX_EVENTS_PER_BATCH` on `ingest-events` only. The agent refuses to start with a larger `max_batch_events`, because the server rejects an oversized batch whole. |
| `presign_expiry_seconds` | `900` | not passed | Upload URL lifetime. |
| `presign_view_expiry_seconds` | `300` | not passed | View URL lifetime, validated 30–3600. Shorter than the upload TTL on purpose: an upload URL is consumed immediately by the agent, while this one hands a human read access to an image of somebody's screen, and a longer window is a longer period in which a forwarded link still works. |
| `create_db_migrate_function` | `true` | `var.create_db_migrate_function` | Requires `<artifact_dir>/db-migrate.zip`. |

#### `modules/lambda/modules/function`

The per-function submodule. Every value is set by the `lambda` module's function catalogue, so none
of these is deployer-facing; they are listed because the catalogue is where per-function memory,
timeout and IAM live.

| Variable | Default | Notes |
|---|---|---|
| `function_name` | — | `${name_prefix}-${key}`. |
| `description` | — | Shows up in the console. |
| `artifact_path` | — | `filename` rather than an `archive_file` data source, precisely so `terraform validate` does not require the artifact to exist. |
| `handler` | `index.handler` | |
| `runtime` | `nodejs22.x` | |
| `architecture` | `arm64` | Validated `arm64` or `x86_64`. |
| `memory_size` | `512` | Catalogue sets 256 (nonce-sweeper) to 1024 (ingest, reporting, admin, aggregation, retention, migrate). Also determines CPU share. |
| `timeout` | `15` | Catalogue sets 10–300s; 300 for the aggregation, retention and migration jobs. |
| `ephemeral_storage_size` | `512` | Size of `/tmp`. |
| `environment_variables` | `{}` | **Never a secret value — only ARNs and names.** |
| `reserved_concurrent_executions` | `-1` | `-1` leaves the function on the unreserved account pool. Only `ingest-events` reserves. |
| `subnet_ids` | `[]` | Empty means the function runs outside the VPC. Every WorkLens function is in the VPC. |
| `security_group_ids` | `[]` | Required when `subnet_ids` is non-empty. |
| `log_retention_days` | `30` | |
| `log_kms_key_arn` | — | |
| `log_level` | `INFO` | Lambda's own logging configuration, alongside the application's `LOG_LEVEL`. |
| `policy_statements` | `[]` | Every statement must name concrete resource ARNs. `scripts/check-iam.sh` fails the build on `Resource = "*"` without a justifying annotation. |
| `layers` | `[]` | No layers are attached. |

#### `modules/observability`

| Variable | Default | Root passes | Notes |
|---|---|---|---|
| `kms_deletion_window_days` | `30` | not passed | Waiting period before a scheduled CMK deletion completes. Validated 7–30. |
| `cloudtrail_bucket_name` | — | computed in root | |
| `cloudtrail_name` | — | computed in root | Must match the name used to build the bucket policy. |
| `enable_cloudtrail_s3_data_events` | `false` | `var.enable_cloudtrail_s3_data_events` | |
| `screenshot_bucket_arn` | — | computed in root | Scopes the data-event selector. |
| `device_root_key_length` | `32` | not passed | Characters of generated key material before base64 encoding; 32 gives a 256-bit key. Validated `>= 32`. |
| `secret_recovery_window_days` | `30` | not passed | Secrets Manager recovery window after deletion. `0` forces immediate deletion. |
| `alarm_email` | `null` | `var.alarm_email` | |

#### `modules/scheduling`

| Variable | Default | Root passes | Notes |
|---|---|---|---|
| `enabled` | `true` | `var.enable_schedules` | Sets each rule's state to ENABLED or DISABLED. |
| `aggregate_timesheets_function_arn` / `_name` | — | wired from `lambda` | |
| `retention_sweeper_function_arn` / `_name` | — | wired from `lambda` | |
| `nonce_sweeper_function_arn` / `_name` | — | wired from `lambda` | |
| `aggregation_schedule_expression` | `cron(45 20 * * ? *)` | `var.aggregation_schedule_expression` | Validated as a `cron(...)` or `rate(...)` expression. |
| `retention_schedule_expression` | `cron(0 22 * * ? *)` | not passed | Deliberately offset from aggregation so the two are never reading and deleting the same rows at once: aggregation should have turned yesterday's events into timesheets before retention may delete anything. |
| `nonce_sweep_schedule_expression` | `rate(1 hour)` | not passed | Hourly keeps `device_nonces` small. Separate from the retention sweeper on purpose — conflating them would tie a security control's cadence to a data-policy setting. |
| `aggregation_lookback_days` | `3` | `var.aggregation_lookback_days` | Delivered in the event payload as `lookback_days`, validated 1–31. |
| `retention_max_deletions_per_run` | `200000` | not passed | Delivered as `max_deletions_per_run`. Bounds a first run against a long backlog, or a run after someone shortens a retention window sharply, so it cannot become an unbounded delete that times out halfway. The next run continues where this one stopped. Validated `>= 1000`, or retention can never catch up. |
| `maximum_event_age_in_seconds` | `7200` | not passed | Two hours of retries covers a transient RDS failover or a Lambda throttle; beyond that the next schedule is the better recovery path than a very old retry. Validated 60–86400. |
| `maximum_retry_attempts` | `3` | not passed | Validated 0–185. |
| `dlq_retention_seconds` | `1209600` | not passed | 14 days, the SQS maximum, for inspecting a dead-lettered invocation. |
| `alarm_topic_arn` | `null` | wired from `observability` | Null disables the dead-letter alarm. |

#### `modules/alarms`

| Variable | Default | Root passes | Notes |
|---|---|---|---|
| `alarm_topic_arn` | — | wired from `observability` | Receives ALARM and OK notifications. |
| `lambda_function_names` | `{}` | wired from `lambda` | Builds one error alarm per function. |
| `lambda_error_threshold` | `5` | not passed | Errors in a 5-minute period that trip the per-function alarm. |
| `ingest_function_name` | — | wired from `lambda` | Alarmed separately for throttles, which is the signal that the reserved concurrency is biting. |
| `rds_instance_id` | — | wired from `database` | |
| `rds_allocated_storage_gb` | — | wired from `database` | The instance's *current* allocated storage, not `var.db_allocated_storage`: autoscaling makes the two diverge, and a threshold pinned to the initial 20 GB would become a 4% threshold on a grown 100 GB volume. |
| `rds_free_storage_threshold_pct` | `20` | not passed | |
| `rds_cpu_threshold_pct` | `80` | not passed | Average over 10 minutes. |

---

## 3. Backend environment

`backend/src/shared/config.ts` is the authority. It parses the environment with Zod **once at module
load**, not at first use, so a missing or malformed variable fails on a function's very first
invocation with a message naming the variable — on deploy, rather than at 2 a.m. from deep inside
whichever handler happened to reach that line first.

In AWS these are Lambda environment variables written by `infra/modules/lambda`. For local work:

```bash
cp backend/.env.example backend/.env
```

Read §9 before trusting the generated file — several names in `.env.example` are not the names the
code reads.

### 3.1 Every variable the backend reads

"Required" means the schema has no default. "Set in AWS" means `infra/modules/lambda` writes it;
variables marked *code default* run on the schema default in the deployed stack, so changing them
means editing the module.

| Variable | Type / allowed | Default | Set in AWS | What it does |
|---|---|---|---|---|
| `ENVIRONMENT` | string, non-empty | `prod` | yes, `var.environment` | Names the deployment. Also a safety input: `prod` plus `LOG_REQUEST_BODIES` is a startup failure. |
| `AWS_REGION` | string, non-empty | **required** | by the Lambda runtime | Never set by Terraform — the Lambda runtime provides it. Locally you must set it yourself, or config parsing fails. |
| `LOG_LEVEL` | `debug`\|`info`\|`warn`\|`error` | `info` | yes, `var.lambda_log_level` | Application log verbosity. |
| `LOG_REQUEST_BODIES` | `0`\|`1`\|`true`\|`false` | `0` | no — code default | Includes request bodies in logs and disables personal-data key redaction in the logger. **Off, and rejected outright when `ENVIRONMENT=prod`.** Bodies contain window and page titles; CloudWatch retention is not the retention policy the organisation configured for activity data. |
| `DB_HOST` | string, non-empty | **required** | yes | RDS endpoint address, no port. |
| `DB_PORT` | integer 1–65535 | `5432` | yes | |
| `DB_NAME` | string, non-empty | **required** | yes | |
| `DB_USER` | string, non-empty | **required** | yes, the app role | The role the functions connect as. |
| `DB_IAM_AUTH` | `0`\|`1`\|`true`\|`false` | `1` | yes, `"true"` | When true the pool signs a short-lived RDS IAM token per connection instead of using a password. This is how the deployed stack authenticates; there is no database password anywhere in it. |
| `DB_PASSWORD` | string, optional | unset | never | Local development only, ignored when IAM auth is on. `DB_IAM_AUTH=false` with no password is a startup failure — set one or the other, deliberately. |
| `DB_SSL_MODE` | `disable`\|`require`\|`verify-full` | `verify-full` | yes, `"verify-full"` | A flat default, not host-dependent; see §9. |
| `DB_POOL_MAX` | integer 1–20 | `1` | no — code default | Keep at 1. `db.t4g.micro` allows roughly 85 connections; a warm fleet of containers each holding several would exhaust that long before CPU became the limit. Raise only behind RDS Proxy. |
| `DB_MASTER_SECRET_ARN` | string, optional | unset | `db-migrate` only | The RDS-managed master credential. Migrations grant `rds_iam`, which needs `rds_superuser`, so the application role cannot bootstrap its own privileges. |
| `DB_APP_USER` | string, optional | unset | `db-migrate` only | The role migrations grant to. Informational; the grants themselves live in migration `0003`. |
| `DEVICE_ROOT_KEY_SECRET_ARN` | string, optional | unset | yes, on every device route | The secret from which per-device secrets are derived. Every device route verifies its own HMAC — a REST API Lambda authorizer is never given the request body, and the signature covers a hash of it — so each of them needs this, not just `enroll`. |
| `HMAC_TIMESTAMP_SKEW_SECONDS` | integer 30–900 | `300` | yes, `var.hmac_timestamp_skew_seconds` | Accepted clock skew for `X-WL-Timestamp`. |
| `NONCE_RETENTION_SECONDS` | integer 600–86400 | `600` | yes, `var.nonce_retention_seconds` | How long device nonces are remembered for replay rejection. **Must exceed the skew window**; see §3.2. |
| `MAX_EVENTS_PER_BATCH` | integer 1–5000 | `500` | `ingest-events` only | Events accepted in one batch. An oversized batch is rejected whole. |
| `INGEST_MAX_BODY_BYTES` | integer 1024–10485760 | `1048576` | no — code default | Request body ceiling, enforced in the shared HTTP layer. |
| `DEVICE_QUOTA_EVENTS_PER_WINDOW` | integer 100–1000000 | `5000` | no — code default | Per-device ingest quota. Generous relative to a 60-second sample interval, so it only ever catches a malfunctioning or hostile agent. |
| `DEVICE_QUOTA_WINDOW_SECONDS` | integer 60–86400 | `3600` | no — code default | The rolling window for the above. |
| `SCREENSHOT_BUCKET` | string, optional | unset | screenshot, reporting, admin, retention functions | Not given to every function: a typo in one variable should not break all of them, which is what `requireConfig` exists to make loud. |
| `SCREENSHOT_PREFIX` | string | `screenshots/` | yes, from the storage output | Key prefix all screenshot objects live under. IAM is scoped to it. |
| `S3_KMS_KEY_ARN` | string, optional | unset | same functions as the bucket | Presigned PUTs are pinned to this key, so a URL cannot write an unencrypted object. |
| `PRESIGN_EXPIRY_SECONDS` | integer 60–3600 | `900` | yes | Upload URL lifetime. The agent requests one immediately before uploading, so it never needs to hold a valid URL for long. |
| `PRESIGN_VIEW_EXPIRY_SECONDS` | integer 30–3600 | `300` | yes | View URL lifetime. Shorter, because these grant a human read access to a screenshot of someone's screen. |
| `MAX_SCREENSHOT_BYTES` | integer 1024–20971520 | `5242880` | no — code default | Largest screenshot the presign endpoint will authorise. Applied in the Zod schema, and enforced in the presigned URL's Content-Length condition rather than merely checked in the handler. The schema additionally clamps it to 20 MB. |
| `AGGREGATION_LOOKBACK_DAYS` | integer 1–31 | `3` | no — code default | The fallback when an invocation carries no `lookback_days`. The scheduled runs always carry one, from `var.aggregation_lookback_days`. |
| `AGGREGATION_REGEX_BUDGET_MS` | integer 1–1000 | `5` | no — code default | Per-event ceiling on regex evaluation for project title rules, so a pathological pattern cannot stall the aggregation job. |
| `COGNITO_USER_POOL_ID` | string, optional | unset | no | When set, the token issuer is re-checked. Unset it is skipped — the API Gateway authorizer already checks it, so this is belt and braces against an authorizer pointed at the wrong pool. |
| `COGNITO_CLIENT_ID` | string, optional | unset | no | As above, for the audience (`aud` on an ID token, `client_id` on an access token). |

`NODE_OPTIONS=--enable-source-maps` is also set on every function by Terraform. It is a runtime flag,
not application configuration, and `config.ts` does not read it.

### 3.2 The cross-field rules

Three checks cannot be expressed field-by-field, and each refuses to start rather than degrading
quietly:

1. **`DB_IAM_AUTH=false` with no `DB_PASSWORD`.** Set one or the other: IAM authentication for the
   deployed stack, a password for a local database.
2. **`NONCE_RETENTION_SECONDS` must exceed `HMAC_TIMESTAMP_SKEW_SECONDS`.** Nonces are what stop a
   captured request being replayed. Expiring them sooner than the window in which a timestamp is
   still accepted reopens exactly that hole. With the defaults there is 600 s of nonce memory against
   a ±300 s window. The same ordering is asserted in Terraform's variable descriptions and in
   `wl_sweep_device_nonces`, so all three layers agree.
3. **`ENVIRONMENT=prod` with `LOG_REQUEST_BODIES` enabled.** Refused, for the reason in the table.

---

## 4. Dashboard environment

`dashboard/src/lib/env.ts` is the authority. Four variables, all read as literal property accesses
because Next.js inlines `NEXT_PUBLIC_*` at **build** time — a dynamic key would not be substituted and
would be `undefined` at run time. Changing any of these therefore requires a rebuild, not a restart.

```bash
cp dashboard/.env.example dashboard/.env.local
```

Validation is deliberately *not* thrown at module load. `assertEnv()` fails at the point of use,
naming every missing variable at once, so a missing value breaks the page that needed it with the
context of which page that was — rather than breaking the build with no context.

**Nothing here is a secret.** The Cognito app client uses the authorisation-code flow with PKCE and
has no client secret, which is why there is none to keep out of the browser bundle.

| Variable | Required | Terraform output | What it does |
|---|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | yes | `api_base_url` | The API root, including the stage — e.g. `https://abc123.execute-api.ap-south-1.amazonaws.com/v1`. |
| `NEXT_PUBLIC_COGNITO_DOMAIN` | yes | `cognito_hosted_ui_domain` | The hosted-UI domain that serves the sign-in page. |
| `NEXT_PUBLIC_COGNITO_CLIENT_ID` | yes | `cognito_client_id` | The public app client id. |
| `NEXT_PUBLIC_APP_URL` | yes | — (must match a `dashboard_origins` entry) | Where this dashboard is served from. `callbackUrl` is derived as `<this>/api/auth/callback` with any trailing slash stripped, and Cognito matches redirect URIs **exactly** — a trailing-slash difference is a failed login, not a warning. |
| `COGNITO_ISSUER_URL` | no | `cognito_issuer_url` | Documented in `.env.example` and emitted by `make env-dashboard`, but **not read by any code in `dashboard/src`**. See §9. |

Security headers are not configurable. `dashboard/next.config.ts` sets `X-Frame-Options: DENY`,
`nosniff`, HSTS, `Referrer-Policy: no-referrer` (a full referrer would leak a presigned screenshot
signature into the logs of anything the browser subsequently talks to) and a `Permissions-Policy`
that denies camera, microphone, geolocation and payment. That last one is stated explicitly rather
than left to the default, because "this product does not use your camera or microphone" is a promise
the agent makes and the dashboard should not quietly contradict.

---

## 5. Per-organisation monitoring configuration

This is the runtime surface: one `monitoring_config` row per organisation, edited by an owner at
`/settings/monitoring`, replaced by `PUT /v1/config`, and fetched by every agent from
`GET /v1/device/config`.

It is `PUT`, not `PATCH`, and every mutable field is required. This is the row that decides what is
collected from employees' laptops; the settings screen shows every field with its privacy impact
stated and a diff-confirm dialog before saving. A partial update would let a caller change screenshot
capture without ever seeing, or restating, the exclusion list that ships alongside it — and "I didn't
realise that was still on" is not an acceptable outcome here.

Writing the row bumps `config_version` **in the same statement**, because the version is how a change
actually reaches a laptop. A configuration saved without a bumped version is a setting the fleet never
applies.

### 5.1 Every setting

The Default column is the column default in `monitoring_config`, which is what a new organisation
gets from `wl_seed_org_defaults()`. Bounds are the CHECK constraints, mirrored field-for-field by the
Zod schema in `backend/src/schemas/dashboard.ts`.

| Setting | Type | Default | Bounds | What it does |
|---|---|---|---|---|
| `config_version` | integer | `1` | `> 0` | Bumped on every change. Not settable; the agent polls, compares, and reloads without restarting. |
| `sample_interval_seconds` | integer | `60` | 15–900 | How often the agent takes a sample. |
| `idle_threshold_seconds` | integer | `300` | 60–3600 | How long without input counts as idle. Five minutes, not thirty seconds: a shorter threshold turns reading a document into idle time. |
| `capture_window_titles` | boolean | `true` | — | Whether the window title is recorded at all. |
| `capture_urls` | boolean | **`false`** | — | Whether a derived site host and page title are recorded. Off by default. |
| `screenshot_enabled` | boolean | **`false`** | — | Whether screenshots are taken at all. Off by default. |
| `screenshot_interval_seconds` | integer | `900` | 60–7200 | Only meaningful when screenshots are on. |
| `screenshot_blur` | boolean | **`true`** | — | Blurs the image before upload. On by default, so turning blur *off* is the deliberate act. |
| `work_hours_only` | boolean | `true` | — | Collect only inside the window below. On by default. |
| `work_hours_start` | time | `09:00` | ≠ end | Interpreted in the employee's own timezone. |
| `work_hours_end` | time | `17:30` | ≠ start | A window where end < start spans midnight. |
| `work_days` | smallint[] | `{1,2,3,4,5}` | 1–7 entries, all within 1–7, no repeats | ISO-8601 weekdays: 1 = Monday … 7 = Sunday, matching `extract(isodow from …)`. |
| `excluded_apps` | text[] | `{}` | ≤ 200 entries, ≤ 400 chars each | Case-insensitive substring match against the executable path or name. |
| `excluded_url_patterns` | text[] | `{}` | ≤ 200 entries, ≤ 400 chars each | Glob-style patterns matched against the derived host and the raw window title. |
| `retention_days_events` | integer | `90` | 1–3650 | How long activity events are kept. |
| `retention_days_screenshots` | integer | `30` | 1–3650, and ≤ `retention_days_events` | How long screenshots are kept. |
| `updated_by_user_id` | uuid | null | FK to `users` | Who last changed it. Set from the verified token, not the request body. |
| `updated_at` | timestamptz | `now()` | — | Assigned explicitly in the update statement: unlike `employees` or `projects`, this table has no `wl_touch_updated_at` trigger. |

Work hours are evaluated in the **employee's** timezone (`employees.timezone`, defaulting from
`organizations.timezone`, itself `Asia/Kolkata`), not the server's and not the laptop's. A laptop's
timezone is user-changeable and the work-hours window is employer policy, so it must not move because
somebody changed a system setting on a trip.

### 5.2 The defaults are the least-invasive set that still produces a defensible timesheet

This is a product commitment, not a convenience. Every default above is the minimum that still lets
an organisation defend a timesheet, and each of the four toggles defaults the safe way:

- **`screenshot_enabled = false`.** A timesheet does not need images of somebody's screen. Screenshots
  are the single most invasive thing this product can do, so they are the one thing an owner has to
  turn on deliberately, having read the privacy note next to the switch.
- **`capture_urls = false`.** Application names and durations are enough to account for a working day.
  Site hosts are a materially more revealing record — a banking domain or a health site in an
  activity log is a different category of fact — so URL capture is opt-in.
- **`screenshot_blur = true`.** Because the default has to hold even after somebody turns screenshots
  on. Defaulting blur off would mean one switch produces legible screenshots of documents and chats;
  defaulting it on means legibility is its own, second, deliberate choice.
- **`work_hours_only = true`**, `09:00–17:30`, Monday–Friday. Evenings and weekends are not
  collected unless somebody widens the window. The default assumes a normal working week rather than
  assuming consent to be observed at all hours.
- **`capture_window_titles = true`** is the one toggle that defaults *on*, and it is where the line
  sits: without titles a timesheet reads "chrome.exe, 6 h 20 m", which is not a defensible record of
  anything. Titles are what make the number reviewable by the person it describes. An organisation
  that disagrees turns it off and keeps a working — if coarser — timesheet.
- **Retention: 90 days of events, 30 days of screenshots.** Short, and the images shorter than the
  events. Long enough for a payroll dispute or a quarterly review, not long enough to become a
  permanent behavioural archive.

### 5.3 The CHECK constraints, and why they are the real enforcement

Bounds are validated three times: the settings form, the Zod schema on `PUT /v1/config`, and these
constraints. The first two can be bypassed — a direct database session, a future handler that forgets
a schema, a migration written in a hurry. The constraints cannot, which is why the privacy invariants
live here and not only in the API layer.

| Constraint | Rule | Why it exists |
|---|---|---|
| column checks | `sample_interval_seconds between 15 and 900`, `idle_threshold_seconds between 60 and 3600`, `screenshot_interval_seconds between 60 and 7200`, `retention_days_events between 1 and 3650`, `retention_days_screenshots between 1 and 3650`, `config_version > 0` | Keeps every interval in a range the agent will accept. The agent validates the same bounds on receipt and falls back to its least-invasive configuration if they are violated, so an out-of-range value collects *less*, never more. |
| `monitoring_config_work_hours_chk` | `work_hours_start <> work_hours_end` | Equal start and end is rejected rather than silently meaning "all day". An all-day window is expressed by setting `work_hours_only = false`, which is visible in the UI and in the audit log. A start that equals its end would be an all-day window that reads, at a glance, like a zero-length one. |
| `monitoring_config_work_days_chk` | `array_length(work_days, 1) between 1 and 7` and `work_days <@ array[1..7]` | An empty array would mean "no work days", which the agent would read as "never capture" — a configuration that looks like monitoring is on while nothing is collected. A value outside 1–7 would silently never match `extract(isodow …)`. |
| `monitoring_config_retention_chk` | `retention_days_screenshots <= retention_days_events` | **The privacy invariant.** Keeping images longer than the activity that explains them serves no legitimate purpose: a screenshot with no surrounding event context cannot be interpreted, only looked at. |

One related invariant lives on the events table rather than here, and is worth knowing about because
it is what makes the idle-time promise real: `activity_events_idle_no_attribution_chk` rejects any
idle event carrying an application, executable, window title, host or page title. Idle minutes cannot
be used to infer what was on screen, and the database is the layer an application bug cannot route
around.

### 5.4 What is *not* enforced by a constraint

`capture_urls` has no effect unless `capture_window_titles` is also on — the agent derives the site
host from the browser's window title, and `internal/capture/sampler.go` gates the derivation on both
flags. Neither the CHECK constraints nor the Zod schema encode that dependency, so the combination
`capture_urls = true, capture_window_titles = false` saves successfully and then collects no URL data
at all. It fails in the safe direction, but it does fail silently.

---

## 6. What the agent gets from the server, and what it does not

The split is the point of the arrangement, so it is worth stating plainly.

**From the server, every 15 minutes, via `GET /v1/device/config`:** everything in §5.1 except
`org_id`, `updated_by_user_id` and `updated_at`. That is, every decision about *what is collected*.
The projection is written field-by-field rather than as a spread with `org_id` removed, so adding a
column to `monitoring_config` does not silently start shipping it to the whole fleet — a new setting
reaches the agent when somebody decides it should.

**From the local `config.json`:** machine-level facts only — the API URL, TLS pins, log level, and
the intervals at which the agent *ships* what it has. Nothing in that file can widen what is
collected. An operator with write access to a laptop's `config.json` cannot turn screenshots on.

The agent caches the fetched configuration in its local buffer's meta table, so it keeps honouring the
correct rules while offline. An agent that reverted to defaults after a restart would start collecting
things the organisation had turned off.

---

## 7. Agent local settings

Three separate files, deliberately, in `%LOCALAPPDATA%\WorkLens` on Windows (per-user, not
per-machine: the agent runs as a logon task in the employee's own session, and its buffer contains
that user's window titles, so it belongs under their profile with their ACL). Both directories are
created `0700`.

| File | Contents |
|---|---|
| `config.json` | Machine-level settings, below. Readable, contains no secret. |
| `credentials.json` | Device id and secret from enrolment. Written `0600`, never logged. |
| `buffer.db` | The offline event buffer, plus the cached monitoring configuration in its meta table. |

Splitting the credential out is the whole point: a single settings file gets screenshotted, emailed,
and pasted into chat threads when something goes wrong, and the secret must not be in it. `Credentials`
implements `String()` so that a credential passed to a logger, a `%v` or an error message cannot print
the secret — relying on every call site to remember is the assumption that eventually fails.

There is no `.env` file for the agent. Precedence is **environment > `config.json` > defaults**, which
lets a deployer test against a staging endpoint without editing a file the installer manages.
`config.json` is decoded with `DisallowUnknownFields`, so a typo in a setting name is an error rather
than a silently ignored line.

### 7.1 `config.json`

| Key | Type | Default | What it does |
|---|---|---|---|
| `api_base_url` | string | none — **required** | The deployment's API root, including `/v1`. Must be `https`, refused outright otherwise; `http` is permitted only against `localhost`/`127.0.0.1` for testing. The agent transmits window titles, so there is no deployment where clear text is acceptable and a warning would just be ignored. |
| `tls_pinning_enabled` | bool | absent = **on** | Certificate pinning against the four Amazon roots. Absent means on: pinning must be the default and turning it off must be an explicit act. The only legitimate reason to disable it is a mandatory corporate TLS-inspection proxy, where the alternative is an agent that does not function. The agent logs a warning on **every** startup while it is off — a silent downgrade would be worse than no pinning. |
| `tls_pins` | []string | built-in Amazon root pins | Overrides the built-ins with base64 or hex SHA-256 SPKI digests. |
| `log_level` | string | `info` | `debug`, `info`, `warn` or `error`. Anything else fails validation. |
| `upload_interval_seconds` | int | `60` | How often the uploader drains the buffer. Matches the default sample interval: batching more aggressively would delay a timesheet without saving meaningful bandwidth, since 60 samples is a few kilobytes either way. |
| `config_poll_interval_seconds` | int | `900` | How often the monitoring configuration is re-fetched, so a policy change reaches the fleet without a restart. |
| `heartbeat_interval_seconds` | int | `300` | How often liveness is reported, which is what makes "this laptop has not checked in since Tuesday" visible on the dashboard. |
| `max_batch_events` | int | `500` | Caps one upload. **Validation refuses anything above 500**, the server's limit: the server rejects an oversized batch whole, so every upload would fail and the agent would look offline while being perfectly connected. |
| `buffer_max_bytes` | int64 | `0` → 250 MB | Ceiling on buffered event volume. Zero or negative uses `store.DefaultMaxBytes`. |
| `buffer_max_age_hours` | int | `0` → 14 days | Drops buffered events older than this regardless of size. Zero or negative uses `store.DefaultMaxAge`. |
| `dashboard_url` | string | empty | Where the employee sees their own data. Appears in the first-run notice and the tray menu, so somebody told they are monitored is also told where to look. |
| `notice_org_name` | string | empty | Named in the first-run notice. |
| `notice_contact_name` | string | empty | Named in the first-run notice. |
| `notice_contact_email` | string | empty | A person to ask. |

The three `notice_*` values and `dashboard_url` are settings rather than prose because a notice that
tells somebody they are being monitored and offers nobody to contact has informed them of very little.
`NoticeIsComplete()` requires the org name and the contact email — but it is deliberately **not** part
of `Validate()`. An incomplete notice must not stop the agent from running, because the alternative is
a deployer deleting the notice configuration to get past a startup error. The agent logs a warning and
`worklens-agentctl doctor` reports it as something to fix before rollout.

### 7.2 Environment overrides

Namespaced so they cannot collide with anything else on a corporate image.

| Variable | Overrides | Notes |
|---|---|---|
| `WORKLENS_DATA_DIR` | the data directory | Read by `DefaultDataDir()` before the platform default. |
| `WORKLENS_API_BASE_URL` | `api_base_url` | |
| `WORKLENS_TLS_PINNING` | `tls_pinning_enabled` | Accepts `off`/`0`/`false`/`no`/`disabled` and `on`/`1`/`true`/`yes`/`enabled`. An operator who writes "0" means the same thing as one who writes "false", and refusing one of them would look like the flag is broken. |
| `WORKLENS_TLS_PINS` | `tls_pins` | Comma-separated. |
| `WORKLENS_LOG_LEVEL` | `log_level` | |

On Windows, an unset `LOCALAPPDATA` is a hard error rather than a guessed path: it usually means the
agent was installed as a service, where it cannot observe the desktop at all, and guessing would hide
that.

### 7.3 Enrolment writes the config for you

`api_base_url` is the only required setting, and a first enrolment writes it:

```bash
worklens-agentctl enroll --token wlen_... --api-url https://abc123.execute-api.ap-south-1.amazonaws.com/v1
```

`--data-dir` overrides the data directory and `--force` replaces an existing credential — which
creates a *second* device whose timesheet is split across both, so it is not the default. Enrolment
tokens are generated in the dashboard under Settings → Devices, and `expires_in_hours` defaults to 24
and is capped at 168: a token is a bearer credential that mints device credentials, so its lifetime is
the window in which a leaked one is useful.

### 7.4 Two changes that need a restart

Said plainly because the alternative is a deployer who changes a setting and sees nothing happen.
When a new configuration version arrives, exclusions and work hours apply immediately, but a changed
`sample_interval_seconds` or `screenshot_interval_seconds` takes effect at the next agent restart —
the sampler and screenshotter read their intervals once at start. The agent logs exactly that on every
config change.

---

## 8. Secrets are not configuration

There are two genuine secrets in this system, and neither is a value anybody types into a file.

**The device root key** is generated by Terraform (`random_password`, 32 characters of key material)
and written to a KMS-encrypted Secrets Manager secret at `${prefix}/device-root-key`. Per-device
secrets are *derived* from it on demand rather than stored, so a database dump yields no working
device credential. The secret's payload is versioned —
`{ "current_key_version": n, "keys": { "n": "<base64>" } }` — and rotation is additive: publish v2 and
devices move to it as they re-enrol. A `lifecycle` block keeps `apply` from reverting a rotated key,
because rotation is an operational action, not a Terraform one.

Because `random_password` keeps its result in state, the state file is sensitive. That is precisely why
`infra/bootstrap` exists: the state belongs somewhere encrypted, versioned and lock-protected, not in
a working directory that gets copied between laptops.

**The database master password** never enters Terraform state at all. `manage_master_user_password =
true` hands generation and rotation to RDS, which keeps the credential in its own Secrets Manager
secret under a customer-managed CMK. Only the `db-migrate` function may read it. Everything else
authenticates with RDS IAM, signing a short-lived token per connection, which is why there is no
database password anywhere in the deployed stack.

Neither value should ever appear in `terraform.tfvars`, in `backend/.env`, in a Lambda environment
variable, or in a support ticket. Lambda environment variables carry ARNs and names only — that rule
is written into the `function` submodule's own variable description.

---

## 9. Where the example files and the code disagree

`backend/.env.example` and `dashboard/.env.example` are the documented interface; `config.ts` and
`env.ts` are what actually runs. They have drifted, and `make env-backend` / `make env-dashboard`
generate files matching the *examples*, so a generated file does not currently satisfy the validators.
This is recorded here rather than quietly worked around.

### 9.1 Backend: names in `.env.example` the code does not read

| `.env.example` says | `config.ts` reads | Effect |
|---|---|---|
| `DEVICE_SIGNATURE_WINDOW_SECONDS` | `HMAC_TIMESTAMP_SKEW_SECONDS` | The example's value is ignored; the schema default of 300 applies. |
| `INGEST_MAX_BATCH_EVENTS` | `MAX_EVENTS_PER_BATCH` | As above, defaulting to 500. |
| `S3_SCREENSHOT_BUCKET` | `SCREENSHOT_BUCKET` | The bucket is unset, so screenshot handlers fail on `requireConfig`. |
| `S3_SCREENSHOT_KMS_KEY_ID` | `S3_KMS_KEY_ARN` | As above. |
| `S3_PRESIGN_UPLOAD_TTL_SECONDS` | `PRESIGN_EXPIRY_SECONDS` | Defaults to 900. |
| `S3_PRESIGN_VIEW_TTL_SECONDS` | `PRESIGN_VIEW_EXPIRY_SECONDS` | Defaults to 300. |
| `S3_MAX_SCREENSHOT_BYTES` | `MAX_SCREENSHOT_BYTES` | Defaults to 5 MB. |
| `DB_MIGRATOR_USER` | — | Not read anywhere in `backend/src`. |
| `DB_SSL_CA_PATH` | — | Not read anywhere in `backend/src`. The CA bundle ships at `backend/assets/rds-ca-global-bundle.pem`. |

Variables the code requires that `.env.example` does not mention at all: **`DB_USER`** (required, no
default — this is the one that makes a generated `backend/.env` fail outright, since the example emits
`DB_APP_USER` instead), plus `ENVIRONMENT`, `DB_IAM_AUTH`, `DB_MASTER_SECRET_ARN`,
`NONCE_RETENTION_SECONDS` and `SCREENSHOT_PREFIX`. `DB_IAM_AUTH` is the practically important omission
for local work: it defaults to true, so a local Postgres container needs `DB_IAM_AUTH=0` — which the
example never mentions, while telling you to leave `DB_PASSWORD` empty.

Two smaller notes. `.env.example` says `DB_SSL_MODE` "defaults to verify-full for an
`*.rds.amazonaws.com` host and disable for anything else"; the schema has a flat default of
`verify-full` with no host inspection. And `cognitoAuth.ts` comments that `infra/modules/lambda` passes
`COGNITO_USER_POOL_ID` / `COGNITO_CLIENT_ID` "only to the pre-token trigger" — the module passes them
to no function at all, so the issuer and audience re-check is inert everywhere.

### 9.2 Dashboard

`make env-dashboard` emits `NEXT_PUBLIC_COGNITO_USER_POOL_ID`, which neither `.env.example` nor
`env.ts` mentions, and **omits `NEXT_PUBLIC_APP_URL`**, which `env.ts` requires — so a generated
`.env.local` fails `assertEnv()`. `COGNITO_ISSUER_URL` is documented and emitted but read by nothing
in `dashboard/src`. The `env.ts` header comment describes a `serverEnv` export that does not exist in
the file.

The checked-in `dashboard/.env.local` does contain all four required variables, which is why local
development works and this has not been noticed.

### 9.3 Terraform

`db_backup_retention_days` is validated `1–35` at the root but `>= 7` in `modules/database`. A value
of 3 passes the root validation and then fails inside the module, so the effective floor is 7 and the
root's error message is the one you will not see. The root's own description ("Zero would disable
point-in-time recovery") explains the wrong bound.

### 9.4 Elsewhere

`docs/SECURITY.md` §1 requirement 9 cites `agent/.env.example` as evidence. **That file does not
exist** — the agent has no `.env` interface at all, only `config.json` and the five `WORKLENS_*`
environment variables in §7.2.

Finally, one break in the runtime configuration path itself, which matters because it is the
mechanism §5 depends on. `GET /v1/device/config` responds
`{ "config": { … }, "config_version": n, "server_time": "…" }`, but the agent passes that whole body to
`config.UnmarshalMonitoringConfig`, whose target struct expects the settings at the top level. Only
`config_version` populates; every interval unmarshals as zero, `Validate()` rejects it
(`sample_interval_seconds 0 is outside 15-900`), and `pollConfig` logs "the monitoring configuration is
invalid; keeping the cached one". The server payload also omits `timezone`, which the agent's
`Validate()` requires, so the check would fail on a second count even with the nesting corrected.

The failure direction is safe — the agent keeps its cached configuration, and before it has ever
fetched one it uses `LeastInvasiveConfig()`: titles off, URLs off, screenshots off, blur on,
work-hours-only on, 09:00–17:30 Mon–Fri, UTC. An agent that has not yet fetched a policy must not
collect more than that policy would allow. But it means a configuration change made in the dashboard
does not currently reach the fleet, which is the one thing §1 promises it does. This needs fixing
before the runtime surface can be described as working end to end.

---

## 10. Outstanding deployer placeholders

Four things ship with placeholder values that a deployer must replace. None of them stops
`terraform apply`, which is exactly why they are listed together.

**1. `alarm_email` is unset.** The alarm topic is created with no subscriber, so every alarm publishes
into the void: a failed nightly aggregation would simply not produce timesheets, and nothing would
say so. Set it in `terraform.tfvars` and accept the confirmation email AWS sends — the subscription is
not active until somebody clicks it, so an unconfirmed subscription is indistinguishable from none.

**2. `dashboard_origins` defaults to `["http://localhost:3000"]`, and this is a real production
risk.** That single value drives the API's CORS allowlist, the S3 CORS rule for presigned screenshot
reads, and the Cognito callback and logout URLs. Left in place on a real deployment it means a
permitted origin that an attacker can reach by getting a victim to run something on their own machine
— against an API that serves timesheets and screenshots. Replace it, do not append to it:

```bash
dashboard_origins = ["https://worklens.example.com"]
```

The `api` module's one-origin validation helps here — a list of two fails at plan time — but a list of
one that happens to be `localhost` passes cleanly.

**3. The security and conduct contacts are filled in** — both `SECURITY.md` and
`CODE_OF_CONDUCT.md` now name a real address, and neither carries a placeholder. They are currently
the *same* address, because the project has one maintainer; `CODE_OF_CONDUCT.md` says so explicitly
rather than leaving a reporter to work out that a conduct complaint lands in the same inbox as
everything else. Split them when there is more than one person to split them between.

Neither file is checked by CI, so nothing fails if a future edit reintroduces a placeholder. The
`check-readme` gate covers the README's responsible-use section only.

---

## 11. Quick reference: file by file

| Path | Committed? | What it configures |
|---|---|---|
| `infra/terraform.tfvars.example` | yes | Template. Copy to `infra/terraform.tfvars`, which is gitignored. |
| `infra/variables.tf` | yes | The 38 root variables in §2.1–2.10. |
| `infra/modules/*/variables.tf` | yes | Module inputs, §2.12. |
| `infra/bootstrap/variables.tf` | yes | Remote-state bucket and lock table, §2.11. |
| `infra/backend.tf` | yes | Remote state, commented out until the bootstrap module has run. |
| `backend/.env.example` | yes | Template for local work. See §9.1 before trusting it. |
| `backend/src/shared/config.ts` | yes | **Authoritative** for the backend environment. |
| `dashboard/.env.example` | yes | Template for `dashboard/.env.local`, which is gitignored. |
| `dashboard/src/lib/env.ts` | yes | **Authoritative** for the dashboard environment. |
| `backend/migrations/0001_init.sql` | yes | The `monitoring_config` table: defaults and CHECK constraints. |
| `agent/internal/config/config.go` | yes | Agent settings, paths, and the monitoring-config client type. |
| `%LOCALAPPDATA%\WorkLens\config.json` | no | Per-machine agent settings, §7.1. |
| `%LOCALAPPDATA%\WorkLens\credentials.json` | no | Device credential. `0600`, never logged. |
