# `lambda`

Owns the catalogue of every WorkLens Lambda function: the thirteen data-plane and job functions plus the optional `db-migrate` function, each declared through one invocation of the nested `./modules/function` submodule so that each gets its own execution role, its own inline least-privilege policies and its own KMS-encrypted log group. This module also owns the shared environment blocks (database connection settings, bucket settings, device-auth tuning) and the library of reusable IAM statements that are composed per function. It does not own the API Gateway wiring, the EventBridge schedules, the Cognito trigger permission, or the S3/KMS/Secrets Manager resources it grants access to.

## Design notes

**A function without a role cannot be declared.** The catalogue is a map of function definitions, and every entry goes through `module.function`, which unconditionally creates `aws_iam_role.this` and attaches the log policy. "One role per function, least privilege" (§6 row 3) is therefore structural rather than a convention someone has to remember when adding function number seventeen. The corollary is that the catalogue entries are homogeneous by design: every entry declares the same attribute names with the same types, including `-1` for "no reserved concurrency", because Terraform's `for_each` over a map of objects requires consistent typing and a missing attribute in one entry fails the whole plan.

**IAM statements are composed, not repeated.** The `stmt_*` locals are the alphabet: `rds-db:connect` on one `dbuser` ARN, `GetSecretValue` on one secret, `PutObject` on one prefix, and so on. Each function lists the letters it needs. `enroll` is the only function granted the device root key. `screenshot-presign` gets `PutObject` and KMS encrypt but no `GetObject`; `screenshot-complete` gets `GetObject` but no `PutObject`. `retention-sweeper` and `admin-api` are the only two with `DeleteObject`. Reading a function's `policy_statements` list tells you exactly what it can touch, in one place.

**Every KMS grant is narrowed with `kms:ViaService`.** The functions never call KMS directly — S3 and Secrets Manager call it on their behalf — so the grants are conditioned on `kms:ViaService` equalling `s3.<region>.amazonaws.com` or `secretsmanager.<region>.amazonaws.com`. A leaked role credential cannot be used to decrypt ciphertext by hand; it can only decrypt through the service that produced it.

**S3 grants are prefix-scoped, and the list grants are conditioned on prefix.** Object actions target `${bucket_arn}/${screenshot_prefix}*`, and `ListBucket`/`ListBucketVersions` — which must target the bucket ARN, not an object ARN, because that is how S3 authorises them — carry a `StringLike` condition on `s3:prefix`. That is the only way to express "may list the screenshots prefix and nothing else".

**The pre-token-generation function runs *inside* the VPC.** This looks wrong at first glance for a Cognito trigger and is deliberate: the claims it injects (org, role, employee) come out of Postgres, and Postgres is only reachable from the private subnets. Its other call — `cognito-idp:AdminGetUser` for MFA status — then has no internet route, which is exactly why `modules/network` defaults `enable_cognito_vpc_endpoint` to `true`. Its Cognito permissions are attached by `modules/auth`, which owns the user pool ARN; attaching them here would make the two modules mutually dependent.

**`nonce-sweeper` is a separate function from `retention-sweeper`.** The code comment gives the reason and it is a good one: retention deletes employee data on a schedule an owner configures, and is an auditable data-policy act. Nonce expiry is replay-protection bookkeeping that must run hourly to keep `device_nonces` small, and its window is `nonce_retention_seconds` — a security parameter tied to the HMAC timestamp skew, not to anything a deployer sets in the monitoring config. Merging them would tie the cadence of a security control to a data-policy setting, so that lowering retention to one day would also change how long replays are detectable.

**`ingest_reserved_concurrency` is the database protection valve, not a rate limit.** Each Lambda container holds one connection to Postgres (the `max: 1` module-scope pool from D6), so reserved concurrency on `ingest-events` *is* the cap on database connections from ingest. Beyond it, API Gateway returns 429 and the agent's exponential backoff absorbs it — which the ingestion design is explicitly built to tolerate. This is the mechanism that lets a `db.t4g.micro` survive 50 agents without RDS Proxy.

**`db-migrate` exists because there is no other way in.** RDS is not publicly reachable and there is no NAT gateway, so nothing on an operator's laptop can reach the database. The migration runner therefore ships into the VPC with the SQL embedded in its own bundle. It is also the only function granted `GetSecretValue` on the RDS-managed *master* credential — DDL needs rights the application role does not have — and correspondingly it is the only function with no `rds-db:connect` statement.

**`source_code_hash` is wrapped in `try()`.** `filename` plus `try(filebase64sha256(...), null)` means `terraform validate` and `terraform plan` work before the backend build has produced any zip, while a built artifact still drives redeployment on change. The root stack pairs this with a `check` block that fails the plan by name for any missing artifact, so the failure mode is a clear message rather than a half-created stack.

**X-Ray is off, with the reason recorded in the code.** `tracing_config.mode = "PassThrough"`: enabling active tracing requires `xray:PutTraceSegments` on `Resource: "*"`, which would be the only unconditioned wildcard in the whole IAM surface and would break the CI check that enforces §6 row 3. Structured JSON logs (`log_format = "JSON"`, with `application_log_level` and `system_log_level` set) plus CloudWatch metrics were judged to cover the operational need.

**The only resource wildcard in the module is annotated.** The VPC networking policy needs `ec2:Describe*` on `"*"` because those actions have no resource-level permissions in IAM — there is no narrower ARN to write. The statement carries an `# iam-wildcard-ok:` comment with a justification, which is the marker `scripts/check-iam.sh` requires; an unannotated wildcard fails CI. Everything else, including `ec2:CreateNetworkInterface`, is scoped to the specific subnet, security group and network-interface ARNs.

## Inputs

| Name | Type | Default | Description |
|---|---|---|---|
| `name_prefix` | `string` | required | Prefix applied to the name of every resource in this module. Function names are `<name_prefix>-<key>`. |
| `tags` | `map(string)` | required | Common tag map applied to every taggable resource. |
| `environment` | `string` | required | Deployment environment name, exposed to handlers as `ENVIRONMENT`. |
| `artifact_dir` | `string` | required | Directory holding one zip per function, named `<function key>.zip`. Produced by the backend build. Terraform references the files with `filename`, so `terraform validate` succeeds before they exist, but `apply` needs them. |
| `runtime` | `string` | `"nodejs22.x"` | Lambda runtime for every function. |
| `architecture` | `string` | `"arm64"` | Instruction set architecture for every function. |
| `log_retention_days` | `number` | `30` | CloudWatch Logs retention in days for every function log group. |
| `log_kms_key_arn` | `string` | required | CMK ARN encrypting every function log group. |
| `log_level` | `string` | `"INFO"` | Application log level for every function. |
| `subnet_ids` | `list(string)` | required | Private subnet ids for the data-plane functions. |
| `security_group_ids` | `list(string)` | required | Security groups for the data-plane functions (the Lambda SG). |
| `db_host` | `string` | required | RDS hostname. |
| `db_port` | `number` | required | RDS port. |
| `db_name` | `string` | required | Database name. |
| `db_user` | `string` | required | Database role the functions authenticate as via RDS IAM auth. |
| `db_iam_auth_resource_arn` | `string` | required | `rds-db:connect` resource ARN for `db_user` on this instance. |
| `db_master_user_secret_arn` | `string` | required | ARN of the RDS-managed master credential secret. Only the migration function may read it. |
| `device_root_key_secret_arn` | `string` | required | ARN of the device root key secret (D4). |
| `rds_kms_key_arn` | `string` | required | CMK ARN protecting Secrets Manager secrets; readers need `kms:Decrypt` on it. |
| `screenshot_bucket_name` | `string` | required | Screenshot bucket name. |
| `screenshot_bucket_arn` | `string` | required | Screenshot bucket ARN. |
| `screenshot_prefix` | `string` | `"screenshots/"` | Key prefix all screenshot objects live under. IAM statements are scoped to it. |
| `s3_kms_key_arn` | `string` | required | CMK ARN for screenshot objects. Presigned PUTs must carry it in the SSE-KMS header. |
| `ingest_reserved_concurrency` | `number` | `20` | Reserved concurrency for `ingest-events`. The database protection valve (D6): each container holds one connection, so this caps DB connections from ingest. Agents receive 429 and retry with backoff beyond it. |
| `hmac_timestamp_skew_seconds` | `number` | `300` | Accepted clock skew for `X-WL-Timestamp` (D3). |
| `nonce_retention_seconds` | `number` | `600` | How long device nonces are remembered for replay rejection. |
| `max_events_per_batch` | `number` | `500` | Maximum events accepted in a single ingest batch. |
| `presign_expiry_seconds` | `number` | `900` | Lifetime of presigned screenshot upload/download URLs. |
| `create_db_migrate_function` | `bool` | `true` | Create the `db-migrate` function. RDS is not publicly reachable and there is no NAT gateway, so schema migrations must run from inside the VPC; this function is how `make migrate` reaches the database. Requires `<artifact_dir>/db-migrate.zip`. |

## Outputs

| Name | Description |
|---|---|
| `functions` | Every function keyed by logical name, with its name, ARNs, role and log group. |
| `function_names` | Map of logical function key => Lambda function name. |
| `function_arns` | Map of logical function key => Lambda function ARN. |
| `invoke_arns` | Map of logical function key => invoke ARN for API Gateway `AWS_PROXY` integrations. |
| `role_names` | Map of logical function key => execution role name. |
| `log_group_names` | Map of logical function key => CloudWatch log group name. |
| `pre_token_generation_function_arn` | ARN of the Cognito pre-token-generation trigger. |
| `pre_token_generation_function_name` | Name of the Cognito pre-token-generation trigger. |
| `pre_token_generation_role_name` | Execution role name of the pre-token-generation trigger; `modules/auth` attaches its Cognito policy. |
| `admin_api_role_name` | Execution role name of `admin-api`; `modules/auth` attaches its Cognito user-management policy. |
| `aggregate_timesheets_function_name` | Name of the nightly aggregation function. |
| `aggregate_timesheets_function_arn` | ARN of the nightly aggregation function. |
| `retention_sweeper_function_name` | Name of the data-retention sweep function. |
| `retention_sweeper_function_arn` | ARN of the data-retention sweep function. |
| `nonce_sweeper_function_name` | Name of the hourly replay-nonce expiry function. |
| `nonce_sweeper_function_arn` | ARN of the hourly replay-nonce expiry function. |
| `db_migrate_function_name` | Name of the in-VPC migration function, or `null` when disabled. |
| `expected_artifacts` | Zip file names the backend build must place in `artifact_dir`. |

The per-function outputs exist so that `auth` and `scheduling` can reference one function without taking a dependency on the whole catalogue.

## Security notes

Against `docs/PLAN.md` §6:

- **Row 2 — encryption at rest.** Every function's log group is created by the submodule with `kms_id` set to the `logs` CMK, so no handler output lands in a default-encrypted group.
- **Row 3 — least-privilege IAM per Lambda, secrets in Secrets Manager.** One role per function, enforced structurally. Concrete resource ARNs throughout: `rds-db:connect` on a single `dbuser/<role>`, `GetSecretValue` on a single secret ARN, S3 object actions on a single prefix. No `iam:PassRole` anywhere. `screenshot-presign` has `s3:PutObject` on the screenshots prefix only, as §6 specifies. The one wildcard — EC2 `Describe*` — is annotated for `scripts/check-iam.sh` with the reason no narrower ARN exists. Environment variables carry ARNs and names, never secret values; the variable description in the submodule says so explicitly.
- **Row 4 — admin MFA.** The `pre-token-generation` function is declared here; `modules/auth` grants and wires it.
- **Row 6 — rate limiting.** `ingest_reserved_concurrency` is the per-function half of the layered throttling: WAF rate rule, then stage throttling, then reserved concurrency, then the application quota.
- **Row 11 — retention.** `retention-sweeper` is granted exactly what a sweep needs: DB connect, list and delete on the screenshots prefix, and decrypt through S3.
- **Beyond the checklist.** The assume-role policy is conditioned on `aws:SourceAccount`, so the roles cannot be assumed by Lambda in another account. `logs:CreateLogGroup` is deliberately withheld — the group is Terraform-owned, which is what keeps its CMK and retention from being bypassed by a function creating its own group.

## Gotchas / operational notes

- **The module header comment is stale.** It states that "pre-token-generation runs outside the VPC on purpose". The catalogue entry sets `in_vpc = true` with a detailed comment explaining why it must be *inside*. The catalogue is what applies; the header is wrong and should be fixed.
- **Only `enroll` can read the device root key, but every device route needs it.** `modules/api` wires the HMAC-authenticated device routes with gateway `authorization = "NONE"` and verifies signatures in-handler, which means `device-config`, `ingest-events`, `screenshot-presign`, `screenshot-complete`, `heartbeat` and `notice-ack` all have to derive the per-device secret from the root key (D4). As the catalogue stands, none of them carries `stmt_read_root_key`/`stmt_decrypt_secrets`, and only `enroll` and `nonce-sweeper` get `device_auth_env` (so the others also lack `HMAC_TIMESTAMP_SKEW_SECONDS` and `NONCE_RETENTION_SECONDS`). Either the shared middleware needs those grants added to each device function, or secret verification has to be centralised somewhere that has them. Worth resolving before the device handlers land.
- **`db-migrate` receives `DB_IAM_AUTH = "true"` from the shared `db_env` block** while having no `rds-db:connect` grant — it is meant to authenticate with the master credential from `DB_MASTER_SECRET_ARN`. The handler has to prefer the secret; if it honours `DB_IAM_AUTH` it will fail with an authorization error rather than a connection error.
- **`backend/functions.json` and this catalogue are two lists that must agree.** `functions.json` describes itself as the single source of truth read by `infra/` with `jsondecode(file(...))`, but no Terraform file in `infra/` reads it — the catalogue here is hand-maintained. Adding a function means editing both, and the failure mode of forgetting one is asymmetric: a function in `functions.json` but not here is bundled and never deployed (silent), while a function here but not in `functions.json` has no zip and is caught by the root `check` block (loud). Memory and timeout values are also duplicated between the two files and can drift unnoticed.
- **Renaming a function key destroys and recreates it, its role and its log group.** The log group name is derived from the function name, so history for the old name is orphaned (and still billed until its retention expires). It also invalidates the `role_names` that `modules/auth` attaches policies to.
- **`create_db_migrate_function = false` breaks `make migrate`.** There is no other route to the database. Turning it off is only sensible after the schema is final and you accept that changing it needs the function back.
- **Reserved concurrency is subtracted from the account pool.** `ingest_reserved_concurrency` (default 20) is carved out of the region's 1000-concurrency limit and is unavailable to any other function in the account. Setting it to `0` does not mean "unlimited" — it disables the function entirely.
- **Changing `screenshot_prefix` changes IAM but not existing objects.** Objects already written under the old prefix become unreadable to the reporting and sweeper functions, and unreachable by the `storage` module's lifecycle rule. Treat it as a permanent choice.
- **The environment blocks are shared, so a change fans out.** Editing `db_env` or `bucket_env` updates every function that merges it, which means a full redeploy of most of the stack. That is usually what you want; be aware it is not a one-function change.
- **`presign_expiry_seconds` (default 900) covers both upload and download URLs.** The presign lifetime the agent depends on and the dashboard's short-lived read URLs come from the same variable, so lengthening it for a flaky-network agent also lengthens how long a leaked dashboard URL stays valid.
- **`nonce_retention_seconds` must stay comfortably above `hmac_timestamp_skew_seconds`.** The nonce table is what makes the timestamp window non-replayable; forgetting nonces faster than the window they protect (600 vs 300 by default) reopens the replay hole. Nothing in Terraform validates this relationship.
- **Removing a function from the catalogue deletes it and its log group on the next apply.** Anything referencing it by name — an EventBridge target, an API route, an alarm — must be removed in the same change or the plan fails on a missing map key.
