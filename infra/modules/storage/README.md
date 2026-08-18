# `storage`

Owns the two S3 buckets: the screenshot bucket that agents PUT into via presigned URLs and the dashboard reads via presigned GETs, and the CloudTrail log bucket the trail delivers into. For each it owns block-public-access, ownership controls, versioning, default SSE-KMS encryption, the bucket policy, and lifecycle rules. It also owns the CORS configuration on the screenshot bucket. It does not create the KMS keys (they come from `observability`), the trail itself (also `observability`), or any object.

## Design notes

**The screenshot bucket policy denies unencrypted uploads three different ways, not one.** Presigned PUTs are already pinned to the SSE-KMS header by the presign Lambda, so the policy is belt-and-braces for anything that bypasses that path — a manual `aws s3 cp`, a future handler, a mistake. The three statements cover three genuinely distinct holes: `DenyUnencryptedObjectUploads` catches a request that sets `x-amz-server-side-encryption` to something other than `aws:kms` (SSE-S3, for instance); `DenyUploadsWithoutEncryptionHeader` uses a `Null` condition to catch a request that omits the header entirely, which the `StringNotEquals` test would let through because a missing key makes that condition false; and `DenyUploadsWithForeignKmsKey` catches a request that is properly SSE-KMS but names someone else's key. That last one uses `StringNotEqualsIfExists` and lists *both* the key ARN and the bare key id, because S3 accepts either form in `x-amz-server-side-encryption-aws-kms-key-id` and a policy that lists only one form rejects legitimate uploads that used the other. `IfExists` is what lets a request with no key id at all fall through to the bucket default rather than being denied.

**Transport is constrained twice.** `DenyInsecureTransport` on `aws:SecureTransport = false` blocks plain HTTP, and `DenyOutdatedTlsVersions` on `s3:TlsVersion < 1.2` blocks TLS 1.0/1.1 — the second is the one that actually satisfies "TLS 1.2 minimum", since `SecureTransport` is true for any TLS version.

**Both bucket policies `depends_on` their public-access block.** The ordering matters because these policies contain `Deny` statements against `Principal: "*"`; the code's comment states the intent — the protective configuration lands before the policy that assumes it, so no window exists where the bucket has a policy but not the block.

**`BucketOwnerEnforced` turns ACLs off entirely.** Combined with block-public-access, that removes the whole category of "someone set a public-read ACL on an object". Note that the CloudTrail write statement still requires `s3:x-amz-acl = bucket-owner-full-control`; CloudTrail sends that header and the condition is harmless under enforced ownership, but it is the standard trail policy shape and worth not "cleaning up".

**`bucket_key_enabled = true` on both buckets.** S3 Bucket Keys let S3 derive per-object data keys from a single bucket-level key, which collapses KMS `GenerateDataKey`/`Decrypt` request counts. For a bucket taking one small PNG every 15 minutes per device, KMS request charges would otherwise be a material share of the storage cost.

**The CloudTrail bucket policy conditions on `aws:SourceArn` built from a passed-in string.** `cloudtrail_arn` is a variable, not a module output, and the root stack composes it from account, region and name prefix. The reason is stated in the root `main.tf`: `storage` needs the trail ARN for its bucket policy while `observability` needs the screenshot bucket ARN for the trail's data-event selector, so reading either as an output would create a cycle. Both are deterministic from the account and the name prefix, so both are computed instead. The `aws:SourceArn` condition is what stops the confused-deputy case where another account's trail is pointed at this bucket.

**Screenshot expiration is scoped to the `screenshots/` prefix; the other three lifecycle rules are not.** The prefix-scoped rule is the retention control and matches the prefix exported as `screenshot_object_prefix`, which is also what the Lambda IAM policies narrow `s3:PutObject` to. The unscoped rules handle housekeeping that applies to the whole bucket: incomplete multipart uploads aborted after one day, non-current versions expired after `screenshot_noncurrent_version_days`, and expired delete markers cleaned up. The delete-marker rule exists because versioning is on — deletes leave markers behind, and without this rule they accumulate indefinitely.

**Lifecycle configurations `depends_on` versioning.** The non-current-version and delete-marker rules are meaningless (and rejected) on an unversioned bucket, so versioning has to be in place first rather than merely declared in the same apply.

**The CORS rule allows `PUT` as well as `GET`/`HEAD`, and the agent is not why.** `agent_upload_origins` defaults to empty and the root stack passes it empty, with the reasoning recorded there: the Windows agent is an HTTP client, not a browser, sends no `Origin` header, and therefore never triggers a CORS check. The variable exists for browser-based test tooling. `dashboard_origins` is the list that matters in practice.

## Inputs

| Name | Type | Default | Description |
|---|---|---|---|
| `name_prefix` | `string` | required | Prefix applied to the name of every resource in this module (e.g. `worklens-prod`). |
| `tags` | `map(string)` | required | Common tag map applied to every taggable resource. |
| `screenshot_bucket_name` | `string` | required | Globally unique name for the screenshot bucket. Computed in the root module from a random suffix. |
| `cloudtrail_bucket_name` | `string` | required | Globally unique name for the CloudTrail log bucket. Computed in the root module from a random suffix. |
| `s3_kms_key_arn` | `string` | required | CMK ARN used for default SSE-KMS encryption of screenshot objects. |
| `s3_kms_key_id` | `string` | required | Key id of the screenshot CMK, used in the bucket policy that pins the allowed SSE key. |
| `logs_kms_key_arn` | `string` | required | CMK ARN used for default SSE-KMS encryption of the CloudTrail bucket. |
| `cloudtrail_arn` | `string` | required | ARN of the CloudTrail trail allowed to write to the CloudTrail bucket. Passed as a deterministic string built in the root module rather than read from the `observability` output, so the two modules do not form a dependency cycle. |
| `screenshot_retention_days` | `number` | `30` | Lifecycle expiration for screenshot objects. Second line of defence behind the retention-sweeper Lambda; keep it >= `monitoring_config.retention_days_screenshots`. Validated to be at least 1. |
| `screenshot_noncurrent_version_days` | `number` | `7` | Days a non-current screenshot object version is kept before permanent deletion. |
| `cloudtrail_retention_days` | `number` | `365` | Lifecycle expiration for CloudTrail log objects. |
| `cloudtrail_transition_days` | `number` | `90` | Days before CloudTrail log objects transition to `STANDARD_IA`. |
| `dashboard_origins` | `list(string)` | required | Origins allowed to send cross-origin PUT/GET to the screenshot bucket (the dashboard host). |
| `agent_upload_origins` | `list(string)` | `[]` | Extra origins allowed by CORS for direct agent PUTs. The Windows agent is not a browser and sends no `Origin` header, so this normally stays empty; it exists for browser-based test tools. |

## Outputs

| Name | Description |
|---|---|
| `screenshot_bucket_id` | Name of the screenshot bucket. |
| `screenshot_bucket_arn` | ARN of the screenshot bucket. |
| `screenshot_bucket_regional_domain_name` | Regional domain name of the screenshot bucket (used when building presigned URLs). |
| `screenshot_object_prefix` | Key prefix the lifecycle expiration rule and the Lambda IAM policies are scoped to. |
| `cloudtrail_bucket_id` | Name of the CloudTrail log bucket. |
| `cloudtrail_bucket_arn` | ARN of the CloudTrail log bucket. |

## Security notes

Against `docs/PLAN.md` §6:

- **Row 1 — TLS everywhere.** `DenyInsecureTransport` plus `DenyOutdatedTlsVersions` (`s3:TlsVersion < 1.2`) on the screenshot bucket; `DenyInsecureTransport` on the CloudTrail bucket.
- **Row 2 — encryption at rest.** Both buckets carry default `aws:kms` encryption naming a specific CMK (`s3` for screenshots, `logs` for the trail). The screenshot bucket policy is the enforcement half of §6's "a bucket policy **denies** `s3:PutObject` without `x-amz-server-side-encryption: aws:kms`" — implemented as three statements, and extended beyond what §6 asks for by also pinning *which* key is acceptable.
- **Row 10 — CloudTrail.** The dedicated trail bucket with its lifecycle policy is this module's half; the trail is in `observability`. The write statement is scoped to `AWSLogs/<account-id>/*` and conditioned on `aws:SourceArn`, so only this account's named trail can deliver.
- **Row 11 — configurable retention.** `expire-screenshots` on the `screenshots/` prefix is the "S3 lifecycle rules act as a second line" clause, behind the retention-sweeper Lambda.
- **Beyond the checklist.** S3 Block Public Access on both buckets (§6's closing paragraph asks for bucket *and* account level; the account-level setting is not in this module), `BucketOwnerEnforced` ownership, versioning on both buckets, and `force_destroy = false` so Terraform cannot empty either bucket as a side effect of a destroy.

## Gotchas / operational notes

- **Versioning changes what "delete" means.** With versioning enabled, a plain `DeleteObject` on a screenshot creates a delete marker and retains the previous version; the object is only truly gone once `expire-noncurrent-versions` reaps it, i.e. up to `screenshot_noncurrent_version_days` (default 7) later. If you need an erasure request to be provably immediate, the delete has to be version-aware — this configuration alone does not make it so. Same applies to the lifecycle `expiration` rule, which expires the current version rather than purging history.
- **Two retention numbers must be kept in step.** `screenshot_retention_days` (this module, S3 lifecycle) must be greater than or equal to `monitoring_config.retention_days_screenshots` (the database row the sweeper reads). Set it lower and S3 deletes objects while the database still has rows pointing at them; the dashboard then presigns GETs for keys that 404.
- **`dashboard_origins` cannot be empty.** `aws_s3_bucket_cors_configuration` requires at least one allowed origin, and `allowed_origins` is `concat(dashboard_origins, agent_upload_origins)`. Passing both empty fails the apply.
- **Bucket names are global and permanent.** They are generated in the root stack from `random_id.suffix`, which lives in state. Losing or re-creating that random id renames both buckets, which means destroying and re-creating them — and with `force_destroy = false` the destroy fails while any object remains. Guard the state file accordingly.
- **Only the `screenshots/` prefix expires.** Anything written to another prefix in that bucket lives forever. If a future feature adds a second prefix, it needs its own rule.
- **`aws:SourceArn` on the trail policy is exact-match against a string computed from the name prefix, region and account.** Renaming the trail, changing `var.project`/`var.environment`, or moving regions invalidates the condition and CloudTrail delivery silently starts failing — the trail's own status page is where that shows up, not the Terraform plan.
- **CloudTrail objects transition before they expire.** With the defaults, objects move to `STANDARD_IA` at 90 days and expire at 365. `STANDARD_IA` has a 30-day minimum billing duration, so setting `cloudtrail_retention_days` to less than `cloudtrail_transition_days + 30` means paying for storage you deleted.
- **The screenshot bucket's own tags declare it sensitive** (`DataClass = employee-screenshots`, `Sensitivity = high`). Worth preserving — they are the hook any account-wide policy or cost/compliance report will key off.
