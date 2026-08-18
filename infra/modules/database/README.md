# `database`

Owns the single RDS PostgreSQL 16 instance and everything that wraps it: the private DB subnet group, a parameter group that forces TLS and tunes logging, a pre-created CMK-encrypted CloudWatch log group for the exported `postgresql` log, and the instance itself with storage encryption, IAM database authentication, RDS-managed master credentials, automated backups and deletion protection. It does not create the application database role, run migrations, or hold a database password anywhere.

## Design notes

**No master password exists in this configuration or in Terraform state.** `manage_master_user_password = true` hands generation, storage and rotation to RDS, which keeps the credential in Secrets Manager encrypted with the same `rds` CMK (`master_user_secret_kms_key_id = var.kms_key_arn`). The application never uses it: the Lambdas authenticate with `rds-db:connect` IAM tokens, and the only consumer of `master_user_secret_arn` is the migration function, which needs DDL rights the application role does not have.

**The application role is created by migration `0001`, not by Terraform.** `app_db_username` is a plain variable with no matching resource, because Terraform holds no database connection — there is no route from wherever `terraform apply` runs into these private subnets. The role is created with `GRANT rds_iam` inside the schema migration. What Terraform *does* own is the derived IAM ARN: `iam_auth_resource_arn` composes `arn:<partition>:rds-db:<region>:<account>:dbuser:<DbiResourceId>/<app_db_username>`, which is what the `lambda` module attaches to each function's role. Scoping on `DbiResourceId` rather than the instance identifier is what makes the grant survive a rename and, more importantly, *not* survive a restore-into-a-new-instance — a replaced instance gets a new resource id and the old grant stops matching.

**TLS is enforced at the engine, not just the network.** `rds.force_ssl = 1` makes the server reject non-TLS connections outright, so a client that forgets `sslmode=require` fails rather than silently downgrading. It carries `apply_method = "pending-reboot"`, which is not optional — it is a static parameter and RDS will not apply it dynamically.

**`log_statement = "ddl"` is a privacy control.** Set to `all` or `mod`, PostgreSQL writes statement text to the log, and statement text on this schema means window titles, hostnames and employee identifiers flowing into CloudWatch — a second copy of the data outside the encrypted database and outside the retention sweeper's reach. DDL-only keeps schema changes auditable while never logging DML text. `log_min_duration_statement` still gives slow-query visibility (it logs duration and statement for statements exceeding the threshold, which is why the default is a deliberate 1000 ms rather than 0).

**The log group is created before the instance, on purpose.** If RDS creates the log group itself it gets default encryption and never-expire retention. Declaring `aws_cloudwatch_log_group.postgresql` at the exact path RDS writes to (`/aws/rds/instance/<id>/postgresql`), with `kms_key_id` and `retention_in_days`, means RDS writes into ours instead. The explicit `depends_on` guarantees the ordering that `enabled_cloudwatch_logs_exports` alone would not.

**`max_allocated_storage` is nulled when it equals `allocated_storage`.** RDS rejects a storage-autoscaling ceiling equal to the current allocation, so the ternary translates "same number" into "autoscaling off" rather than letting the API return an error. That is why the variable documents "set equal to `allocated_storage` to disable autoscaling" and it actually works.

**`ca_cert_identifier` is pinned to `rds-ca-rsa2048-g1`** rather than left to the account default, so the CA the agent's and Lambdas' TLS chains see is a property of this configuration and changes only when someone edits it.

**Enhanced monitoring and Performance Insights are both off.** `monitoring_interval = 0` with a comment pointing at the standard CloudWatch metrics, which is what the `alarms` module watches — the metrics needed for CPU, storage, connections and memory alarms are all free-tier instance metrics. Performance Insights is a separate variable, defaulted off on the same cost grounds.

**`allow_major_version_upgrade = false` with `engine_version = "16"`.** A bare major version tracks the latest supported minor, so minor drift is absorbed (and applied in the maintenance window when `auto_minor_version_upgrade` is on) while a major upgrade requires an explicit configuration change.

## Inputs

| Name | Type | Default | Description |
|---|---|---|---|
| `name_prefix` | `string` | required | Prefix applied to the name of every resource in this module (e.g. `worklens-prod`). |
| `tags` | `map(string)` | required | Common tag map applied to every taggable resource. |
| `subnet_ids` | `list(string)` | required | Private subnet ids for the DB subnet group. Must span at least two AZs (validated). |
| `vpc_security_group_ids` | `list(string)` | required | Security groups attached to the instance. Should be the RDS SG only. |
| `kms_key_arn` | `string` | required | CMK ARN used for storage encryption, automated backups and the managed master user secret. |
| `logs_kms_key_arn` | `string` | required | CMK ARN used to encrypt the pre-created PostgreSQL CloudWatch log group. |
| `engine_version` | `string` | `"16"` | PostgreSQL engine version. A bare major version tracks the latest supported minor. |
| `parameter_group_family` | `string` | `"postgres16"` | RDS parameter group family. Must match the major engine version. |
| `instance_class` | `string` | `"db.t4g.micro"` | RDS instance class. `db.t4g.micro` is the Graviton burstable class costed in `docs/PLAN.md` §10. |
| `allocated_storage` | `number` | `20` | Initial storage in GiB. |
| `max_allocated_storage` | `number` | `100` | Upper bound for storage autoscaling in GiB. Set equal to `allocated_storage` to disable autoscaling. |
| `storage_type` | `string` | `"gp3"` | EBS volume type backing the instance. |
| `db_name` | `string` | `"worklens"` | Name of the initial database created on the instance. |
| `master_username` | `string` | `"wl_admin"` | Master user name. Its password is generated and rotated by RDS in Secrets Manager, never handled by Terraform. |
| `app_db_username` | `string` | `"worklens_app"` | Database role the Lambdas authenticate as with IAM auth. Created by migration `0001` (`GRANT rds_iam`), not by Terraform, because Terraform holds no database connection. |
| `database_port` | `number` | `5432` | TCP port the instance listens on. |
| `backup_retention_period` | `number` | `7` | Days of automated backups to retain. Validated to be at least 7 per `docs/PLAN.md` §6. |
| `backup_window` | `string` | `"18:00-19:00"` | Daily UTC window for automated backups (`hh:mm-hh:mm`). |
| `maintenance_window` | `string` | `"sun:19:30-sun:20:30"` | Weekly UTC maintenance window (`ddd:hh:mm-ddd:hh:mm`). |
| `multi_az` | `bool` | `false` | Run a standby in a second AZ. Off by default; roughly doubles the instance cost. |
| `deletion_protection` | `bool` | `true` | Refuse to delete the instance. Required on by `docs/PLAN.md` §6. |
| `apply_immediately` | `bool` | `false` | Apply modifications immediately instead of during the maintenance window. |
| `log_retention_days` | `number` | `30` | CloudWatch Logs retention for exported PostgreSQL logs. |
| `log_min_duration_statement_ms` | `number` | `1000` | Log statements slower than this many milliseconds. `-1` disables. |
| `performance_insights_enabled` | `bool` | `false` | Performance Insights. Off by cost decision in `docs/PLAN.md` §10. |
| `auto_minor_version_upgrade` | `bool` | `true` | Allow RDS to apply minor engine upgrades during the maintenance window. |

## Outputs

| Name | Description |
|---|---|
| `instance_id` | DB instance identifier. |
| `instance_arn` | DB instance ARN. |
| `resource_id` | `DbiResourceId` of the instance. Required to build `rds-db:connect` IAM ARNs. |
| `endpoint` | `host:port` endpoint of the instance. |
| `address` | Hostname of the instance. |
| `port` | Port the instance listens on. |
| `db_name` | Name of the initial database. |
| `master_username` | Master user name. |
| `master_user_secret_arn` | ARN of the RDS-managed Secrets Manager secret holding the master credentials. Used only by the migration function. |
| `app_db_username` | Database role the Lambdas authenticate as via IAM auth. |
| `iam_auth_resource_arn` | `rds-db:connect` resource ARN for the application database role. |
| `log_group_name` | CloudWatch log group receiving exported PostgreSQL logs. |
| `parameter_group_name` | Name of the parameter group applied to the instance. |

## Security notes

Against `docs/PLAN.md` §6:

- **Row 1 — TLS everywhere.** `rds.force_ssl = 1` in the parameter group; the engine refuses plaintext connections.
- **Row 2 — encryption at rest.** `storage_encrypted = true` with `kms_key_id` set to the `rds` CMK. The same CMK encrypts automated backups (inherited from the volume) and the RDS-managed master user secret. `copy_tags_to_snapshot = true` and `delete_automated_backups = false` keep snapshots identifiable and retained. The exported PostgreSQL log group is CMK-encrypted via `logs_kms_key_arn`.
- **Row 3 — least privilege, secrets in Secrets Manager.** The master credential is generated and rotated by RDS into Secrets Manager and is never in state, in a variable, or in a Lambda environment. `iam_auth_resource_arn` narrows each function's `rds-db:connect` grant to one `dbuser/<role>` on one `DbiResourceId` rather than to the instance or to `*`.
- **Row 6 — private-subnet database.** `publicly_accessible = false`, a subnet group built only from the private subnets, and `vpc_security_group_ids` set to the RDS SG whose only ingress is the Lambda SG on the database port.
- **Beyond the checklist.** `deletion_protection` defaults on and `backup_retention_period` is validated at 7 days minimum, both called for in §6's closing paragraph. `log_connections`/`log_disconnections`/`log_lock_waits` are on for forensics; `log_statement = "ddl"` deliberately keeps DML text — and therefore employee data — out of CloudWatch.

## Gotchas / operational notes

- **The `lifecycle` block says `prevent_destroy = false`.** The comment above it reads "Terraform must never be the thing that silently replaces the database", but the setting as written does not prevent anything. Actual protection comes from `deletion_protection = true` (AWS refuses the delete) and `skip_final_snapshot = false`. If you want Terraform itself to refuse, this is the line to change — and note that flipping it to `true` means a future `terraform destroy` of the whole stack fails until you edit the module.
- **`final_snapshot_identifier` is a fixed name.** `${name_prefix}-pg-final` is not unique per destroy. A destroy that succeeds leaves that snapshot behind, and the *next* destroy of a re-created stack with the same prefix fails because the snapshot identifier already exists. Rename or delete the old snapshot before a second teardown.
- **Destroying this module is a two-step.** `deletion_protection = true` blocks the delete, so a genuine teardown means setting it to `false`, applying that change, then destroying. Note also that the root stack passes the same `var.db_deletion_protection` to both this module and the `auth` module's Cognito pool, so flipping it for a teardown removes protection from two things at once.
- **`parameter_group_family` and `engine_version` must move together.** Bumping to PostgreSQL 17 requires `engine_version = "17"`, `parameter_group_family = "postgres17"`, and `allow_major_version_upgrade = true` in the same change; two of the three produces an error, and only the first produces a plan AWS rejects.
- **`rds.force_ssl` needs a reboot.** It is applied `pending-reboot`, so a fresh change sits inactive until the instance reboots — during the maintenance window, or immediately if `apply_immediately = true`. Verify with `SHOW rds.force_ssl;` before claiming the control is live.
- **`database_port` here must match the `network` module's `database_port`.** They are independent variables fed the same literal by the root stack.
- **`subnet_ids` is validated at two entries but not at two AZs.** The validation counts subnets; passing two subnets in the same AZ satisfies it and then RDS rejects the subnet group. Feed it `module.network.private_subnet_ids`.
- **`multi_az = false` is the default.** Fine for the costed one-org deployment, but it means a failover is a restore, and the standard RDS maintenance and minor-version reboots are visible outages rather than failovers.
- **`apply_immediately = false` means changes queue.** An instance class or parameter change appears in the plan, applies to the AWS config, and then does nothing until the weekly window. Do not conclude the change did not work.
- **Storage autoscaling has no lower gear.** `allocated_storage` can grow but never shrink, and RDS enforces a cooldown between storage modifications. Raising `allocated_storage` is one-way.
