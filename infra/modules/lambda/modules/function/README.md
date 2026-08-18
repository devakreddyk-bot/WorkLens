# `lambda/modules/function`

Owns one Lambda function and everything that is inseparable from it: its dedicated execution role, an inline policy letting it write to its own log group and nowhere else, an inline VPC networking policy when it is VPC-attached, an inline policy assembled from caller-supplied least-privilege statements, and the KMS-encrypted CloudWatch log group itself. It is a leaf submodule invoked once per entry in `modules/lambda`'s function catalogue; it makes no decisions about what a function is for.

## Design notes

**The whole point is that a role cannot be omitted.** `aws_iam_role.this` is unconditional. Because the parent declares every WorkLens function through this submodule, "one role per function" (`docs/PLAN.md` §6 row 3) becomes a property of the code rather than a rule in a document. There is no code path that produces a function sharing a role with another.

**The log group is Terraform's, not Lambda's, and the role cannot create one.** `aws_cloudwatch_log_group.this` is declared at `/aws/lambda/<function_name>` with `kms_key_id` and `retention_in_days`, and `logging_config.log_group` points the function at it explicitly. The logs policy grants only `CreateLogStream` and `PutLogEvents`, scoped to that group's ARN and `<arn>:*` — `logs:CreateLogGroup` is deliberately absent. Without that omission, a function whose group was missing would quietly create an unencrypted, never-expiring replacement, which would defeat both the CMK requirement and the retention setting. Withholding the permission means such a failure is loud.

**The log group ARN is composed by hand rather than taken from the resource.** `local.log_group_arn` is built from partition, region, account and function name. This is a small piece of decoupling that keeps the IAM policy document from depending on the log group resource, which matters given the explicit `depends_on` ordering below.

**`ec2:CreateNetworkInterface` is scoped; `ec2:Describe*` cannot be.** The VPC policy has three statements. The Describe statement uses `Resource: "*"` because those actions genuinely have no resource-level permissions in IAM, and it carries an `# iam-wildcard-ok:` annotation with a justification — the marker `scripts/check-iam.sh` demands, so an unjustified wildcard anywhere else fails CI. The create statement lists the concrete subnet ARNs, security group ARNs and the network-interface pattern (all three are required together; `CreateNetworkInterface` authorises against each). The manage statement covers delete, IP assignment and tagging on network interfaces only.

**`depends_on` on the function is load-bearing, not defensive.** Lambda attaches the ENI as part of the create call, so if the VPC policy has not landed yet the first create fails with an authorization error — and the retry lands in a confusing half-state. Listing the log group and both inline policies forces the ordering that Terraform's implicit graph would not guarantee, since the function references only the role ARN.

**The assume-role policy is conditioned on `aws:SourceAccount`.** A service-principal trust policy with no condition can, in principle, be assumed on behalf of another account's resources. Pinning the source account closes that. `max_session_duration = 3600` keeps the credential lifetime at the minimum useful value.

**`filename` + `try(filebase64sha256(...), null)` instead of an `archive_file` data source.** The variable description states the reason: `archive_file` evaluates at plan time and would make `terraform validate` fail before the backend build has run. With `filename` and a `try`-guarded hash, validate and plan work on a clean checkout, and once the zip exists its hash is what triggers a redeploy. The trade-off is that a stale zip produces no diff — the hash is the only change signal.

**X-Ray is off deliberately.** `tracing_config.mode = "PassThrough"` with the reason inline: active tracing needs `xray:PutTraceSegments` on `Resource: "*"`, which would be the only unconditioned wildcard in the IAM surface. Structured JSON logs (`log_format = "JSON"`, with separate application and system log levels — system pinned at `WARN` so runtime chatter does not drown handler output) plus CloudWatch metrics were judged sufficient.

**Being in the VPC is inferred, not flagged.** `local.in_vpc = length(var.subnet_ids) > 0` drives the `vpc_config` block, the VPC policy, and the ENI-related `depends_on`. One input decides all three, so there is no way to attach a function to subnets and forget its networking permissions.

**`environment` is a dynamic block.** An empty `environment_variables` map produces no `environment` block at all rather than an empty one, which avoids a perpetual diff against the AWS API's representation of "no environment".

## Inputs

| Name | Type | Default | Description |
|---|---|---|---|
| `function_name` | `string` | required | Full Lambda function name. |
| `description` | `string` | required | What this function does. Shows up in the console; keep it useful. |
| `tags` | `map(string)` | required | Common tag map applied to every taggable resource. |
| `artifact_path` | `string` | required | Path to the deployment zip. The backend build produces it; Terraform only references it. `filename` is used rather than an `archive_file` data source precisely so that `terraform validate` does not require the artifact to exist yet. |
| `handler` | `string` | `"index.handler"` | Module and exported function to invoke. |
| `runtime` | `string` | `"nodejs22.x"` | Lambda runtime identifier. |
| `architecture` | `string` | `"arm64"` | Instruction set architecture. arm64 (Graviton) is ~20% cheaper per GB-second. Validated to `arm64` or `x86_64`. |
| `memory_size` | `number` | `512` | Memory in MB, which also determines CPU share. |
| `timeout` | `number` | `15` | Maximum execution time in seconds. |
| `ephemeral_storage_size` | `number` | `512` | Size of `/tmp` in MB. |
| `environment_variables` | `map(string)` | `{}` | Environment variables for the function. Never put secret values here, only ARNs and names. |
| `reserved_concurrent_executions` | `number` | `-1` | Reserved concurrency. `-1` leaves the function on the unreserved account pool. |
| `subnet_ids` | `list(string)` | `[]` | Private subnet ids. Empty list means the function runs outside the VPC. |
| `security_group_ids` | `list(string)` | `[]` | Security groups for the function's ENIs. Required when `subnet_ids` is non-empty. |
| `log_retention_days` | `number` | `30` | CloudWatch Logs retention in days for this function's log group. |
| `log_kms_key_arn` | `string` | required | CMK ARN encrypting this function's log group. |
| `log_level` | `string` | `"INFO"` | Minimum application log level captured by the Lambda logging configuration. |
| `policy_statements` | `list(object({ sid = string, actions = list(string), resources = list(string), conditions = optional(list(object({ test = string, variable = string, values = list(string) })), []) }))` | `[]` | Extra least-privilege IAM statements for this function's role. Every statement must name concrete resource ARNs. The only resource wildcards in this module are the EC2 Describe actions that AWS does not support resource-level permissions for. |
| `layers` | `list(string)` | `[]` | Lambda layer ARNs to attach. |

## Outputs

| Name | Description |
|---|---|
| `function_name` | Name of the function. |
| `arn` | ARN of the function. |
| `qualified_arn` | Version-qualified ARN of the function. |
| `invoke_arn` | ARN used by API Gateway `AWS_PROXY` integrations. |
| `role_name` | Name of the function's execution role. |
| `role_arn` | ARN of the function's execution role. |
| `log_group_name` | Name of the function's log group. |
| `log_group_arn` | ARN of the function's log group. |

## Security notes

Against `docs/PLAN.md` §6:

- **Row 2 — encryption at rest.** The log group is created with `kms_key_id = var.log_kms_key_arn`; the function is pointed at it by name, and the role cannot create an alternative.
- **Row 3 — least-privilege IAM per Lambda.** A dedicated role per function; only `Allow` statements (the `extra` policy document hard-codes `effect = "Allow"`, so a caller cannot inject a `Deny` that masks something); every caller-supplied statement must name concrete ARNs; `iam:PassRole` appears nowhere; the trust policy is account-conditioned. The single EC2 `Describe*` wildcard is annotated with the justification `scripts/check-iam.sh` requires.
- **Beyond the checklist.** Withholding `logs:CreateLogGroup` prevents a function from routing its own logs around the CMK and retention policy. `system_log_level = "WARN"` limits how much runtime detail reaches logs. `max_session_duration = 3600` is the floor for a role session.

## Gotchas / operational notes

- **`policy_statements` accepts only `Allow`.** The `effect` is fixed inside the module. If you need a `Deny`, this is not the place — it has to go on the resource policy of the thing being protected.
- **Statements are merged into one inline policy named `function`.** IAM's managed-policy character limits apply to inline policies too (2048 characters for a role's inline policy is the *user* limit; roles get 10,240). A function with a long list of statements and long ARNs can hit it, and the error names the policy, not the statement that pushed it over.
- **A stale zip produces no diff.** `source_code_hash` is the only change signal. If the build wrote a byte-identical zip, or did not run at all, `terraform apply` reports no changes and the old code stays deployed. Build first, then apply — never the reverse.
- **A missing zip is not caught here.** `try()` makes the hash `null` and the plan succeeds; the `apply` is what fails, and by then other resources may already be created. The root stack's `check "lambda_artifacts_present"` block is what turns this into a plan-time failure naming the missing files, and it only covers functions in the parent catalogue.
- **`subnet_ids` and `security_group_ids` must be set together.** Passing subnets with an empty security-group list produces a function AWS will reject at create time; nothing in the module validates the pair.
- **Changing `function_name` replaces everything.** The role name (`<function_name>-role`) and log group name (`/aws/lambda/<function_name>`) are both derived from it, so a rename orphans the old log group with its history — and the group is not deleted, it just stops receiving data until its retention expires.
- **`reserved_concurrent_executions = 0` disables the function.** It is not a synonym for "no reservation"; `-1` is. Any positive value is also subtracted from the account's shared concurrency pool for the region.
- **Deleting a VPC-attached function is not instant.** Lambda reclaims the ENIs asynchronously, which is why destroying the network module behind it can appear to hang for several minutes.
- **`ephemeral_storage_size` below 512 is invalid**, and the KMS key must permit the CloudWatch Logs service principal to use it or the log group creation fails — that grant lives in the `observability` module's key policy, not here.
