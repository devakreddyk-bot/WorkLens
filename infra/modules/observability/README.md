# `observability`

Owns the cross-cutting security plumbing that almost everything else depends on: three customer-managed KMS CMKs (`rds`, `s3`, `logs`) with rotation enabled and hand-written key policies, the multi-region CloudTrail trail with log file validation, the Secrets Manager secret holding the device root key (D4) and its initial generated value, and the SNS topic alarms publish to — including its policy and an optional email subscription. It owns no alarms; those are in the `alarms` module.

## Design notes

**This module is applied first, and that is why it is shaped the way it is.** Almost every other module needs one of its CMKs — RDS storage, the screenshot bucket, every CloudWatch log group, the CloudTrail bucket, the SNS topic. Producing keys means it cannot also consume the things that use them, which is the whole reason `alarms` exists separately (see that module's README) and why `cloudtrail_bucket_name`, `cloudtrail_name` and `screenshot_bucket_arn` arrive as plain strings computed in the root stack rather than as `storage` outputs. Taking them as outputs would create a cycle: `storage` needs the trail ARN for its bucket policy, and the trail here needs the bucket name and the screenshot bucket ARN.

**`resources = ["*"]` in a KMS key policy is not a wildcard in the usual sense.** A key policy is attached to exactly one key, and `"*"` inside it resolves to *that key alone* — there is no narrower form to write, and writing the key's own ARN is not permitted at policy-creation time anyway (the key does not exist yet when the policy is composed). Every such line here carries an `# iam-wildcard-ok:` annotation saying so, which is what `scripts/check-iam.sh` requires. The narrowing that matters is done by conditions instead, and each key does it differently:

- **`rds`** — `kms:CallerAccount` pinned to this account plus `kms:ViaService` limited to `rds.<region>` and `secretsmanager.<region>`. So the key can be used for RDS storage and for the two Secrets Manager secrets (the RDS-managed master credential and the device root key), and for nothing else, by no one outside the account.
- **`s3`** — the same account-and-`ViaService` pattern for `s3.<region>`, plus a third statement granting direct data-key use to account principals. The code's stated reason for the third statement is that presigned PUT/GET URLs are signed locally by the Lambdas, which need the key directly rather than through the S3 service principal to compute SSE-KMS headers.
- **`logs`** — five separate service grants, each conditioned. CloudWatch Logs is scoped by `kms:EncryptionContext:aws:logs:arn` to log groups in this account and region, so the key cannot be used to encrypt someone else's log group. CloudTrail's encrypt grant is conditioned on `aws:SourceArn` equalling the specific trail. The CloudTrail *reader* grant is conditioned on the CloudTrail encryption context. And `delivery.logs.amazonaws.com` is granted for the WAF module's log group, conditioned on `aws:SourceAccount`.

The `EnableRootAccountKeyAdministration` statement on each key is the standard KMS idiom: without a policy statement admitting the account root, the key becomes unmanageable, because KMS does not fall back to IAM the way most services do. It is what allows the per-function role policies in `modules/lambda` to grant KMS access at all.

**Three keys rather than one, so a blast radius is a blast radius.** Separating RDS/Secrets, S3 objects and logs means a key policy mistake or a scheduled deletion affects one data class. It also lets the `ViaService` conditions be tight; a single key serving all three would need the union of every service principal, which is most of the benefit gone.

**The device root key is generated once and then Terraform stops touching it.** `aws_secretsmanager_secret_version` carries `ignore_changes = [secret_string]` with the reason stated: rotation is an operational action documented in `docs/OPERATIONS.md`, and without the ignore, the next `apply` would revert a rotated key — which would invalidate every device secret derived from the new version and break the whole fleet's authentication at once. The stored shape is a versioned map (`current_key_version` plus `keys: { "<version>": "<base64>" }`) precisely so that D4's rotation story works: publish version 2, bump `current_key_version`, let devices re-enroll onto it as `devices.key_version` advances, retire version 1.

**CloudTrail S3 data events are off by default, and the second event selector is why the toggle is safe.** Data events are billed per event and the application's own `audit_log` table already records every screenshot view against an actor and a subject, which is the record that matters for §6 row 10. When the toggle is on, *two* advanced event selectors are created — one for `AWS::S3::Object` events under the screenshot bucket prefix and one for management events — because specifying any advanced event selector replaces CloudTrail's default management-event logging. Without that second selector, enabling data events would silently turn management-event logging off, which is the more valuable of the two.

**Log file validation is on.** `enable_log_file_validation = true` produces digest files, which is what lets you prove the trail has not been tampered with after the fact. For a system whose purpose is monitoring employees, an audit trail you cannot prove is intact is not much of a control.

**The SNS topic is encrypted and its policy is narrow.** `kms_master_key_id` is the `logs` CMK, so alarm notifications are encrypted at rest; the topic policy allows `sns:Publish` only from `cloudwatch.amazonaws.com` with an `aws:SourceAccount` condition, and denies `Publish`/`Subscribe` over non-TLS transport. The email subscription is optional so a deployer can wire Slack, PagerDuty or a chatbot instead.

## Inputs

| Name | Type | Default | Description |
|---|---|---|---|
| `name_prefix` | `string` | required | Prefix applied to the name of every resource in this module (e.g. `worklens-prod`). |
| `tags` | `map(string)` | required | Common tag map applied to every taggable resource. |
| `kms_deletion_window_days` | `number` | `30` | Waiting period (days) before a scheduled CMK deletion completes. Validated to 7–30. |
| `cloudtrail_bucket_name` | `string` | required | Name of the S3 bucket (created by the `storage` module) that receives CloudTrail logs. |
| `cloudtrail_name` | `string` | required | Name of the CloudTrail trail. Must match the trail name used to build the bucket policy. |
| `enable_cloudtrail_s3_data_events` | `bool` | `false` | Log S3 object-level (data plane) events for the screenshot bucket in CloudTrail. Off by default: data events are billed per event ($0.10 per 100k) and the application `audit_log` table already records every screenshot view. |
| `screenshot_bucket_arn` | `string` | required | ARN of the screenshot bucket, used to scope CloudTrail S3 data events. |
| `device_root_key_length` | `number` | `32` | Character length of the generated device root key before base64 encoding. 32 chars => 256-bit key material. Validated to be at least 32. |
| `secret_recovery_window_days` | `number` | `30` | Secrets Manager recovery window (days) after deletion. `0` forces immediate deletion. |
| `alarm_email` | `string` | `null` | Optional email address subscribed to the alarm SNS topic. Leave `null` to wire subscribers manually. |

## Outputs

| Name | Description |
|---|---|
| `rds_kms_key_arn` | ARN of the CMK encrypting RDS storage and Secrets Manager secrets. |
| `rds_kms_key_id` | Key id of the RDS CMK. |
| `s3_kms_key_arn` | ARN of the CMK encrypting S3 screenshot objects. |
| `s3_kms_key_id` | Key id of the S3 CMK (used in SSE-KMS headers on presigned PUTs). |
| `logs_kms_key_arn` | ARN of the CMK encrypting CloudWatch log groups, CloudTrail and SNS. |
| `cloudtrail_arn` | ARN of the multi-region CloudTrail trail. |
| `cloudtrail_name` | Name of the CloudTrail trail. |
| `device_root_key_secret_arn` | ARN of the Secrets Manager secret holding the device root key (D4). |
| `device_root_key_secret_name` | Name of the device root key secret. |
| `alarm_topic_arn` | SNS topic that receives CloudWatch alarm notifications. |

## Security notes

Against `docs/PLAN.md` §6:

- **Row 2 — encryption at rest with KMS.** This module is the source of all three CMKs the plan names (`rds`, `s3`, `logs`), each with `enable_key_rotation = true`. Every other module's encryption setting resolves to one of them.
- **Row 3 — secrets in Secrets Manager.** The device root key lives in a Secrets Manager secret encrypted with the `rds` CMK, and per-device secrets are derived from it rather than stored (D4), which is what makes a database dump useless for authenticating as a device. Note that the *grants* to read it are in `modules/lambda`, scoped to one ARN.
- **Row 10 — CloudTrail.** Multi-region trail with `include_global_service_events` and `enable_log_file_validation`, writing SSE-KMS encrypted logs to the dedicated bucket the `storage` module creates. The optional S3 data-event selector adds object-level access logging for the screenshot bucket on top of the application `audit_log`.
- **Beyond the checklist.** Every KMS grant is condition-narrowed by account, `ViaService`, source ARN or encryption context — the point being that possession of a role is not sufficient to use a key outside the service that key exists for. The SNS topic is CMK-encrypted and denies non-TLS access.

## Gotchas / operational notes

- **The generated device root key is in Terraform state, in plaintext.** `random_password.device_root_key.result` is a state attribute. Treat the state file as secret material: this is a large part of why `backend.tf` documents migrating to an encrypted, versioned S3 backend with a DynamoDB lock, and it is the one secret in this stack that state *does* hold (the RDS master password never enters state, because RDS manages it). If state has ever been on a laptop or in a chat message, rotate the key.
- **After a rotation, state and reality diverge deliberately.** `ignore_changes = [secret_string]` means Terraform will not notice or revert a rotated secret — which is the intent — but it also means `terraform state show` reports the *original* value indefinitely. The live value is only in Secrets Manager.
- **Never let Terraform recreate the secret on a live fleet.** Replacing the secret (a name change, a destroy/re-apply) generates a new root key, and every enrolled device's derived secret stops verifying. Recovery is re-enrolling the whole fleet.
- **`secret_recovery_window_days = 30` blocks re-applying under the same name.** A destroy schedules the secret for deletion but keeps the name reserved for the recovery window, so a re-apply within 30 days fails with a name conflict. Set it to `0` before a teardown you intend to redo, or delete the secret with `--force-delete-without-recovery`.
- **Deleting a CMK is not recoverable, and objects encrypted with it are not either.** `kms_deletion_window_days` is the only grace period. A destroy that schedules the `s3` key for deletion makes every screenshot object in the bucket permanently unreadable once the window lapses, whether or not the objects still exist. Same for RDS snapshots against the `rds` key.
- **`device_root_key_length` is measured in characters, not bits.** The description reads "32 chars => 256-bit key material", which is true of the *byte length* of the base64-encoded value; the actual entropy is bounded by the generated alphabet (`special = false`, so alphanumeric), roughly 190 bits for 32 characters. Still ample for HMAC-SHA256, but do not quote the 256 figure as an entropy claim.
- **`cloudtrail_name` must match the name the `storage` module's bucket policy was built from.** Both come from the same root-stack local, so they agree by construction — but changing `var.project` or `var.environment` changes the derived trail ARN, and if the bucket policy and the trail are updated in different applies, CloudTrail delivery fails in between. The failure shows up on the trail's status page, not in Terraform output.
- **The module header comment is slightly stale.** It lists "SNS topic + CloudWatch alarms on Lambda errors and RDS health" as belonging to this module; only the topic does. The alarms are in `modules/alarms`.
- **An email subscription needs a human to confirm it.** `aws_sns_topic_subscription` with `protocol = "email"` creates a pending subscription; until someone clicks the link in the confirmation email, no alarm notification is delivered and Terraform reports the subscription as created. Verify in the console before believing alerting works.
- **The topic policy admits only `cloudwatch.amazonaws.com`.** The `logs` key policy also grants `events.amazonaws.com`, but the topic policy does not, so an EventBridge rule cannot publish directly to this topic. Everything currently routes through CloudWatch alarms, so this is not a gap — just do not assume a new EventBridge target can notify without a policy change.
- **Enabling `enable_cloudtrail_s3_data_events` is a real cost lever on a screenshot-heavy deployment.** Every object PUT, GET and DELETE becomes a billed CloudTrail event, and the retention sweeper deletes in batches.
- **`kms_deletion_window_days` cannot be lowered below 7.** The validation enforces AWS's own floor, so a fast teardown is not available for keys.
