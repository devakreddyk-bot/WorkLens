# Deployment

A runbook for bringing WorkLens up in an AWS account from a clean clone, in the order the code
actually requires. Every command here exists in this repository — a `make` target, a script the
target calls, or an `aws`/`terraform` invocation the Terraform itself prints — and each step says
why it sits where it does, because several of the orderings are not obvious and getting one wrong
produces a stack that looks fine and does nothing.

---

## 0. Read this first

**Nothing in this repository has ever been deployed to AWS.** `terraform validate` passes for both
the root stack and the bootstrap stack, `make ci` passes locally, the schema has been applied
against a local PostgreSQL 16, and the agent cross-compiles for `windows/amd64` — but no
`terraform apply` has run, no IAM policy has been exercised, no WAF rule has seen traffic, and no
presigned upload has been made against real S3. This is the same position `docs/SECURITY.md` §4
states, and it applies to this document too: what follows is derived from the code, not from a
deployment that worked.

Practically, that means:

- Expect the first `apply` to fail on something. The likely candidates are named in §17.
- Where this runbook cannot know an answer without a live account, it says so rather than guessing.
- The order below is derived from the dependency graph in `infra/main.tf`, the `filename` argument
  in `infra/modules/lambda/modules/function/main.tf`, and the network position of RDS. It is
  therefore reliable in the sense that the code demands it, not in the sense that somebody has
  walked it end to end.

**This runbook's order differs from the summary in `README.md`.** The README says "a single
`terraform apply`, followed by a database migration, a Lambda bundle upload, an agent build, and a
dashboard deploy — in that order". The Lambda bundles have to exist *before* the first apply,
because each `aws_lambda_function` references its zip with `filename` and the apply fails on a
missing file. The README's ordering describes the steady state, where "Lambda bundle upload" is a
code-only redeploy (§14). The first deployment builds first.

**Before you deploy anything, read `docs/RESPONSIBLE_USE.md` and complete the legal sign-off it
describes.** That is not a formality bolted onto a technical document: this software collects
personal data about identifiable employees, the target jurisdiction is India under the DPDP Act
2023, and the notice and lawful basis are your obligation as the deploying company. The software
cannot do it for you. `docs/SECURITY.md` §5 carries the same checklist from the security side.

---

## 1. What you need

### Tooling

The authoritative minimums are asserted by `make bootstrap` (`GO_MIN_VERSION`, `NODE_MIN_VERSION`,
`TERRAFORM_MIN_VERSION` at the top of the `Makefile`) and pinned in `.github/workflows/ci.yml`:

| Tool | Minimum | Pinned in CI | Where the floor comes from |
|---|---|---|---|
| Go | 1.23 | `1.23` | `agent/go.mod` says `go 1.23`. The comment there notes a dependency with a higher `go` directive silently raises it, which is why `golang.org/x/sys` is held at `v0.30.0`. |
| Node | 22 | `22` | `engines` in both `backend/package.json` and `dashboard/package.json`; the Lambda runtime is `nodejs22.x` (`infra/main.tf`). |
| npm | ships with Node | — | `make bootstrap` runs `npm ci` in `backend/` and `dashboard/`. |
| Terraform | 1.9 | `1.9.8` | `required_version = ">= 1.9.0, < 2.0.0"`. `infra/versions.tf` explains it: the configuration uses variable validation blocks that reference other variables, which earlier versions reject at parse time. |

The AWS provider is pinned to `~> 5.70` and `random` to `~> 3.6`, with `.terraform.lock.hcl`
committed for both stacks. `infra/versions.tf` says why v6 is not taken automatically: it changed
provider-level defaults around default tags and S3 bucket resources, so moving to it is a
deliberate upgrade with a plan review.

Two tools the build needs that `make bootstrap` does **not** check for, so check them yourself:

- **Python 3**, because `scripts/check-functions.sh` shells out to `python3` to parse
  `backend/functions.json`. Without it `make ci` fails in the compliance gate.
- **AWS CLI v2**, because the database migration and every verification step in §13 invoke it.
  Terraform uses the SDK directly and does not need it.

`gitleaks` is optional locally and enforced in CI; `make bootstrap` reports it as such.

### AWS

- An account you are willing to create a VPC, an RDS instance, fourteen Lambda functions, a REST
  API, a WAF WebACL, a Cognito user pool, three KMS CMKs, three S3 buckets (screenshots,
  CloudTrail, and the Terraform state bucket from the bootstrap stack), a DynamoDB lock table, an
  SNS topic, an SQS dead-letter queue and a CloudTrail trail in.
- A region. The default throughout is **`ap-south-1` (Mumbai)**, chosen because India's DPDP Act
  is the target jurisdiction and employee data staying in-country is the easiest position to
  defend. The bootstrap stack, the root stack's `aws_region`, and the `region` in the backend
  block all have to agree; if they do not, `terraform init` finds no state and plans to create
  everything a second time.
- Credentials in the environment or a named profile, resolved the normal way by both the provider
  and the CLI. Nothing in this repository reads an access key from a file it owns.

### The permissions the applying principal needs

**This has never been run against a live AWS account, so the exact IAM policy is derived from the
resources declared in `infra/` rather than observed from a successful apply.** Treat the following
as the service list to grant against, not as a tested policy document:

`ec2` (VPC, subnets, route tables, security groups, gateway and interface endpoints, flow logs),
`rds`, `s3`, `dynamodb`, `lambda`, `iam` (role and inline-policy creation — the lambda module
creates one role per function), `apigateway` including the account-level CloudWatch role setting,
`wafv2`, `cognito-idp`, `kms`, `secretsmanager`, `sns`, `sqs`, `events`, `logs`, `cloudtrail`,
`cloudwatch`, and `sts:GetCallerIdentity` plus `iam:PassRole` for the roles it attaches.

An apply run by a principal with `AdministratorAccess` will work; narrowing it to least privilege
is a piece of work this repository has not done and cannot honestly claim to have verified.

### Decisions to make before the first command

Four values are worth settling now, because changing two of them later means re-applying and
re-generating environment files.

1. **`environment`** — part of every resource name, so `prod` and `staging` can share one account.
   It is also part of the RDS final-snapshot name, which matters at teardown (§16).
2. **The dashboard's origin.** `dashboard_origins` drives the API's CORS allowlist, the S3 CORS
   rule for presigned reads, and the Cognito callback and logout URLs. **It must contain exactly
   one entry.** The root variable's own validation only requires at least one, but
   `infra/modules/api/variables.tf` validates `length(var.cors_allowed_origins) == 1`, because the
   CORS preflight is an API Gateway `MOCK` integration and a mock cannot return a conditional
   `Access-Control-Allow-Origin`. Two origins fail the plan. So decide the dashboard's final
   hostname before the first apply, or accept a second apply once you know it.
3. **`alarm_email`.** Unset means alarms publish to an SNS topic with no subscriber, and a failed
   nightly aggregation silently produces no timesheets. AWS sends a subscription confirmation you
   have to accept by hand.
4. **Whether screenshots will be enabled.** Not a Terraform value — it is per-organisation
   configuration in the dashboard, off by default. It is on this list because it changes what the
   employee notice has to say, and the notice comes before the rollout, not after.

---

## 2. Verify the toolchain

```bash
make bootstrap
```

It does two things, and the first is a hard gate:

**It asserts tool versions.** `go`, `node`, `npm` and `terraform` are each located and compared
against the minimums above by an inline `awk` three-component version comparison. A missing or
too-old tool prints the version found, the version needed and the download URL, and the target
exits non-zero — it does not proceed to install anything. `gitleaks` is reported but never fails
the target.

**Then it installs dependencies**, conditionally: `go mod download` in `agent/` if `agent/go.mod`
exists, `npm ci` in `backend/` and in `dashboard/` if their `package.json` does. Every step is
guarded on the directory being present, so the target succeeds on a partially populated tree —
that is a build-order convenience from earlier phases, not something you will hit now.

It does **not** verify AWS credentials, the AWS CLI, Python, or connectivity. Confirm your
identity separately:

```bash
aws sts get-caller-identity
```

---

## 3. Step 1 — the remote-state bootstrap

The root stack cannot host its own state backend: `terraform init` against an S3 backend whose
bucket does not exist fails before it can create anything. So the backend is its own root module
with its own local state.

```bash
terraform -chdir=infra/bootstrap init
```

```bash
terraform -chdir=infra/bootstrap apply
```

It creates exactly two things:

- **A state bucket** — versioned, `AES256` default encryption, Block Public Access on all four
  settings, `BucketOwnerEnforced` ownership, a bucket policy denying non-TLS access and denying a
  `PutObject` that explicitly asks for no encryption, a lifecycle rule expiring noncurrent
  versions after 90 days (floor of 7, enforced by variable validation), and `prevent_destroy`.
  The name is `worklens-tfstate-<account-id>-<random-hex>` unless you set `state_bucket_name`;
  both the account id and the random suffix are there because S3 names are global.
- **A DynamoDB lock table** — `worklens-tfstate-locks`, `PAY_PER_REQUEST`, SSE and point-in-time
  recovery on, `prevent_destroy`. The `LockID` hash key is fixed by the Terraform S3 backend, not
  a free choice.

Note the deliberate choice of SSE-S3 over a CMK for the state bucket, recorded in
`infra/bootstrap/main.tf`: a customer-managed key would have to be created by the same module, and
a key-policy mistake would lock Terraform out of its own state with no way back in.

Read the module's `backend_block` output — it prints the exact block to paste, already filled in:

```bash
terraform -chdir=infra/bootstrap output -raw backend_block
```

Then uncomment the `terraform { backend "s3" { ... } }` block at the bottom of `infra/backend.tf`
and fill in `bucket`, `key` (one key per environment — `prod/terraform.tfstate`), `region` and
`dynamodb_table` from that output.

```bash
terraform -chdir=infra init
```

Do this **before** the first root apply, so there is no local state to migrate. The comment in
`infra/backend.tf` describes `terraform init -migrate-state` instead; that path is for somebody who
already applied the root stack against local state and is moving it afterwards. Uncommenting first
is simpler, and `-migrate-state` on an empty working directory is a no-op either way.

### One correction to the repository's own comment

`infra/backend.tf` says the bootstrap stack's state "is committed as
`infra/bootstrap/terraform.tfstate` — safe, because it describes nothing but an empty bucket and an
empty table". **It is not committed.** `.gitignore` line 51 (`*.tfstate`) matches it and there is
no negation for it — `git check-ignore -v infra/bootstrap/terraform.tfstate` confirms this. The
reasoning in that comment is sound (the file holds no secret and nothing expensive), but the file
is ignored, so you have to keep it deliberately. Back it up somewhere you will still have it in a
year, or you will be reconciling a `prevent_destroy` bucket and table by hand.

---

## 4. Step 2 — build the Lambda bundles

This comes before the apply. `infra/modules/lambda/modules/function/main.tf` sets

```
filename         = var.artifact_path
source_code_hash = try(filebase64sha256(var.artifact_path), null)
```

The `try()` is what lets `terraform validate` and `terraform plan` succeed on a clean checkout with
no zips built. `apply` is not so forgiving: it needs the file. Its own README states the rule
plainly — *build first, then apply, never the reverse* — and adds the corollary that matters more
later: **a stale zip produces no diff**, because `source_code_hash` is the only change signal.

```bash
make backend-build
```

That runs `npm run build` in `backend/`, which is `tsx scripts/bundle.ts`. The bundler reads
`backend/functions.json` — the same inventory the Terraform catalogue declares from — and writes
one deterministic zip per function to `backend/artifacts/<name>.zip`. Fourteen functions:
`admin-api`, `aggregate-timesheets`, `db-migrate`, `device-config`, `enroll`, `heartbeat`,
`ingest-events`, `nonce-sweeper`, `notice-ack`, `pre-token-generation`, `reporting-api`,
`retention-sweeper`, `screenshot-complete`, `screenshot-presign`.

Two things the bundler does that matter to this runbook:

- **Every zip carries `backend/assets/rds-ca-global-bundle.pem`.** The private subnets have no
  route to the internet, so a function cannot fetch AWS's RDS trust store at run time, and
  `src/shared/db.ts` fails closed rather than downgrading to an unverified connection. This PEM is
  deliberately force-included past `.gitignore` — see `docs/SECURITY.md` §3.4.
- **`db-migrate` embeds the `.sql` files as strings** via esbuild's text loader, so a function
  version and its migration set are one artifact.

Confirm the build and the deployment agree before you plan:

```bash
make check-functions
```

This compares `backend/functions.json` against the catalogue in `infra/modules/lambda/main.tf` and
fails naming the difference in either direction. Both directions are nasty: a function in Terraform
with no zip fails the apply half-way through, and a zip with no function is never deployed while
everything looks fine.

### Do not rely on the root stack's artifact check to catch this

`infra/main.tf` ends with a `check "lambda_artifacts_present"` block whose comment says it "fails
the plan instead, naming the exact missing artifacts", and `infra/modules/lambda/README.md` repeats
the claim. **Terraform `check` block assertions are reported as warnings, not errors** — they do
not fail a plan or an apply. The block is still useful: it names every missing zip in one message
instead of letting you find them one apply-failure at a time. But it is a warning you have to read,
not a gate you can lean on. Run `make backend-build` and `make check-functions` yourself.

---

## 5. Step 3 — write `infra/terraform.tfvars`

```bash
cp infra/terraform.tfvars.example infra/terraform.tfvars
```

`terraform.tfvars` is gitignored; the `.example` is committed. **No secret goes in either file.**
There are only two genuine secrets in this stack and neither is yours to type: the device root key
is generated by Terraform (`random_password`) and stored in Secrets Manager as a versioned map, and
the database master password is generated and rotated by RDS itself under
`manage_master_user_password`, so it never enters Terraform state at all.

Every variable has a working default, so an apply with no tfvars produces a functioning stack. The
values worth changing for a real deployment, with the reason from the code:

| Variable | What to set | Why |
|---|---|---|
| `aws_region` | your region | Must match the bootstrap region and the backend block's `region`. |
| `environment` | `prod` | Part of every resource name and of the RDS final-snapshot name (§16). |
| `dashboard_origins` | `["https://your-dashboard-host"]` | Exactly one entry. Remove `http://localhost:3000`: a permitted localhost origin is a usable target for an attacker who can get a victim to run something locally. |
| `alarm_email` | a monitored address | Otherwise alarms fire into an unsubscribed topic. |
| `api_data_trace_enabled` | leave `false` | Data tracing logs full request and response bodies, and the bodies here are window titles. The module validates the variable to `false`, so turning it on means editing the module — deliberately. |
| `enable_schedules` | `false` for the first apply | Its own description says so: before migrations have run and before any device has enrolled, an aggregation run against an empty schema is log noise. The default is `true`, so this is one you have to set. |
| `screenshot_retention_days` | ≥ the longest window any org will configure | It is an S3 lifecycle backstop, not the policy. The authority is `monitoring_config.retention_days_screenshots`, enforced by the retention sweeper. Set it below the application window and the lifecycle rule deletes data the application still considers live. |
| `waf_count_only` | consider `true` for the first week | Puts the AWS managed rule sets in count-only mode, so you can see what *would* have been blocked before it blocks a real agent. |
| `db_deletion_protection` | leave `true` | Enforced by RDS itself, so it also blocks a deletion attempted from the console. See §16 before you turn it off. |

`cognito_domain_prefix` and the two bucket names are left to derive from a random suffix generated
once and kept in state. That is what lets a first apply succeed without you guessing a Cognito
hosted-UI prefix nobody in the region has taken. It also means **the state file is load-bearing for
the bucket names**: lose it and you are renaming buckets, which with `force_destroy = false` means
a destroy that fails while any object remains.

---

## 6. Step 4 — the root apply

```bash
make tf-plan
```

`tf-plan` runs `terraform -chdir=infra init -input=false` then plans with
`-var-file=terraform.tfvars` into `infra/tfplan`. If the tfvars file is absent it says so and plans
without it rather than failing. Pass extra arguments through `TF_ARGS`, e.g.
`make tf-plan TF_ARGS="-target=module.database"`.

Read the plan. Then:

```bash
make tf-apply
```

`tf-apply` applies `infra/tfplan` if it exists and deletes it afterwards; otherwise it plans and
applies interactively with the tfvars.

The module order in `infra/main.tf` follows the dependency graph, so reading it top to bottom is
reading the order things come up in: **observability** first (three CMKs, the CloudTrail trail, the
device root key secret, the alarm topic), because almost everything else encrypts with one of its
keys; then **network**, **storage**, **database**, **lambda**, **auth**, **api**, **waf**,
**scheduling**, and **alarms** last because every alarm watches something created above it.

Two dependencies are passed as computed strings rather than module outputs — the CloudTrail ARN
into storage's bucket policy, and the screenshot bucket ARN into the trail's data-event selector —
because taking them as outputs would create a cycle. Both are derivable from account, region and
name prefix, so both are built in `locals`.

Things to expect on a first apply:

- **It is slow.** The RDS instance dominates; a single-AZ `db.t4g.micro` typically takes several
  minutes to become available, and the Lambdas cannot be usefully invoked until it is.
- **`aws_api_gateway_account` is a per-account, per-region singleton.** The api module creates the
  account-level CloudWatch Logs role and sets it, because without a role named there API Gateway
  writes no access or execution logs at all, silently. If another stack in the same account and
  region already manages that setting, they will fight — set
  `manage_account_cloudwatch_role = false` in that module's invocation.
- **The `next_steps` output is printed at the end** and is worth reading; it names the exact
  `db-migrate` function, warns if `alarm_email` is unset, and says whether schedules are enabled.

```bash
terraform -chdir=infra output next_steps
```

---

## 7. Step 5 — apply the database migrations

**The migration does not run from your laptop, and cannot.** RDS is in two private subnets with
`publicly_accessible = false` and a security group that admits only the Lambda security group on
5432. There is no NAT gateway and no bastion host — `docs/SECURITY.md` §3.1 and §3.3 record why:
the alternatives were a permanently reachable box holding database access, or a public database.
A short-lived function inside the VPC is neither.

So migrations reach the deployed database by invoking the in-VPC `db-migrate` Lambda. Get its name
from the outputs:

```bash
terraform -chdir=infra output -raw db_migrate_function_name
```

Check what is pending before changing anything. `action: "status"` takes the advisory lock, reads
the ledger, verifies checksums and changes nothing:

```bash
aws lambda invoke --region ap-south-1 --function-name worklens-prod-db-migrate --cli-binary-format raw-in-base64-out --payload '{"action":"status"}' /dev/stdout
```

`--cli-binary-format raw-in-base64-out` is required by AWS CLI v2 to accept a JSON string as
`--payload`. The comments in `backend/src/handlers/jobs/dbMigrate.ts` and
`infra/outputs.tf` show the command without it; without the flag on CLI v2 you get a base64
decoding error rather than an invocation.

`action: "dry-run"` reports what would run, also changing nothing:

```bash
aws lambda invoke --region ap-south-1 --function-name worklens-prod-db-migrate --cli-binary-format raw-in-base64-out --payload '{"action":"dry-run"}' /dev/stdout
```

Then apply. `apply` is the default action, so an empty payload is equivalent:

```bash
aws lambda invoke --region ap-south-1 --function-name worklens-prod-db-migrate --cli-binary-format raw-in-base64-out --payload '{"action":"apply"}' /dev/stdout
```

The response is JSON: `ok`, `applied`, `alreadyApplied`, `pending`, `currentVersion`, a formatted
`status` table and `durationMs`. A failure is **rethrown**, deliberately, so the invocation is
recorded as a failure — a migration that did not apply must not look like a success to a deploy
script checking the exit.

Three migrations ship: `0001_init.sql` (22 tables, the privacy CHECK constraints, the indexes),
`0002_org_bootstrap.sql` (the default app/site category template, `wl_seed_org_defaults()`,
`wl_sweep_device_nonces()`), and `0003_app_role.sql` (the `worklens_app` role).

### Why this function connects as the master user

`0003_app_role.sql` grants `rds_iam`, and only `rds_superuser` can do that, so the app role cannot
bootstrap its own privileges. `db-migrate` reads the RDS-managed master credential from Secrets
Manager — its IAM policy grants `GetSecretValue` on that one ARN and nothing else — while every
other function connects as `worklens_app` with an RDS IAM token. `worklens_app` has DML rights
only: it cannot create, alter or drop anything, cannot read the migration ledger, and cannot
`UPDATE` or `DELETE` the audit log.

### `make migrate` is the local path, not this one

```bash
make migrate
```

runs `npx tsx scripts/migrate.ts` in `backend/`, which reads the `.sql` files off disk and builds a
connection from `backend/.env`. That is for a local PostgreSQL container and for CI. Pointed at the
deployed host it will simply hang until the 15-second connection timeout, because there is no route
— the script's own error text says as much. `npm run migrate -- --status` and
`-- --dry-run` are its equivalents of the two read-only actions above.

### Adding a migration later

`backend/migrations/*.sql` is read from disk by the CLI but **imported by name** in the Lambda:
ESM has no import-time glob, so `BUNDLED_MIGRATIONS` in `dbMigrate.ts` is written by hand. Forget
an entry and the Lambda reports success having applied nothing, while local development looks fine.

```bash
make check-migrations
```

fails the build on any `.sql` file not registered in that list (it also understands a
`.no-transaction.sql` suffix for a migration that must run outside a transaction). There is a
second guard inside the handler: `assertAllMigrationsBundled()` throws if any import resolved to an
empty string, which is what a misconfigured text loader would produce — migrations that "apply"
with no effect while the ledger records success.

---

## 8. Step 6 — create the organisation and the first owner

**There is no supported path for this in the repository, and you should know that before you start
looking for one.** `infra/modules/auth/README.md` states it directly: "Nothing here puts users into
groups. Group membership is created by the admin-api Lambda at runtime. A freshly applied stack has
three empty groups; the first owner has to be created and added to `owner` out of band."

The chicken-and-egg is real. The pre-token-generation trigger resolves a Cognito `sub` to a row in
`users`, and every dashboard route authorises on the `wl:org` and `wl:role` claims that come from
that row. `POST /v1/users` exists and takes a `cognito_sub` in its body — but it is an admin route,
so it needs a caller who already has an owner row. Nothing in the API creates an `organizations`
row at all; a search of `backend/src` finds `wl_seed_org_defaults()` referenced only in comments.

So the first organisation, the first employee and the first `users` row have to be inserted
directly, and the database is not reachable from your laptop. The one mechanism this repository
already has for running SQL inside the VPC is the migration runner, which makes a one-off migration
the workable route.

### 8a. Create the Cognito owner account

Get the pool id, then create the user and put them in the `owner` group. Do **not** set a password
on the command line; let Cognito send the invitation and let the person set their own at first
sign-in.

```bash
terraform -chdir=infra output -raw cognito_user_pool_id
```

```bash
aws cognito-idp admin-create-user --region ap-south-1 --user-pool-id <pool-id> --username owner@example.com --user-attributes Name=email,Value=owner@example.com Name=email_verified,Value=true --desired-delivery-mediums EMAIL
```

```bash
aws cognito-idp admin-add-user-to-group --region ap-south-1 --user-pool-id <pool-id> --username owner@example.com --group-name owner
```

Record the `sub` from the create-user response. It is the immutable identity the `users` row joins
on — `preTokenGeneration.ts` looks users up by `sub` and not by email precisely because an email
address is mutable and matching on it would silently detach somebody from their row.

### 8b. Insert the organisation, the employee and the owner user

Write a new file `0004_bootstrap_org.sql` in `backend/migrations/`. The three inserts have to be one
atomic migration, for the reason `0002_org_bootstrap.sql` gives about org creation generally: doing
it as separate statements invites a half-created organisation if one of them fails.

The `<angle-bracket>` values are identifiers you supply — a company name, a slug, an email address,
the Cognito `sub` from the previous step. **None of them is a secret**, and none of them should be:
if you find yourself wanting to put a credential in a migration, stop.

```sql
-- 0004_bootstrap_org.sql — the deploying company, its first employee, its first owner.
--
-- One-off. Migrations are forward-only and checksummed, so this file can never be edited
-- after it has applied; a mistake here is corrected by a later migration, not by a rewrite.
--
-- A plpgsql block rather than a chain of CTEs, for two reasons that both bite silently:
-- a non-data-modifying CTE that nothing references is never evaluated, so a
-- `select wl_seed_org_defaults(...)` CTE would be dropped by the planner; and every part of
-- a single statement sees the same snapshot, so the function would not find the organisation
-- the same statement had just inserted. Inside a block, each statement sees the previous
-- one's effects.
--
-- The runner wraps this file in BEGIN/COMMIT itself, so there is no transaction control here.

do $$
declare
    v_org_id      uuid;
    v_employee_id uuid;
begin
    insert into organizations (name, slug, timezone)
    values ('<Company Name>', '<company-slug>', 'Asia/Kolkata')
    returning id into v_org_id;

    perform wl_seed_org_defaults(v_org_id);

    insert into employees (org_id, full_name, email, timezone)
    values (v_org_id, '<Owner Full Name>', '<owner@example.com>', 'Asia/Kolkata')
    returning id into v_employee_id;

    insert into users (org_id, cognito_sub, email, role, employee_id)
    values (v_org_id, '<cognito-sub-from-step-8a>', '<owner@example.com>', 'owner', v_employee_id);
end
$$;
```

Three notes on the shape. `slug` is constrained to `^[a-z0-9][a-z0-9-]{1,62}$`. `employees.timezone`
has no column default — unlike `organizations.timezone`, which defaults to `Asia/Kolkata` — so it
has to be supplied. And giving the owner an `employee_id` is optional, since
`users_employee_role_chk` only requires one for the `employee` role, but doing so means the owner
also gets the self-view, which is the behaviour the product wants everybody to have.

`wl_seed_org_defaults()` is what makes this one call rather than three: it gives the organisation
its `monitoring_config` row at the least-invasive defaults — without which the agent has nothing to
fetch — and a copy of the default app and site category template, without which every rollup is a
single "uncategorised" bar. It is idempotent and safe to re-run.

Register it, verify, rebuild and redeploy:

```bash
$EDITOR backend/src/handlers/jobs/dbMigrate.ts
```

Add `{ file: '0004_bootstrap_org.sql', sql: bootstrapOrg0004 }` to `BUNDLED_MIGRATIONS` and the
matching `import bootstrapOrg0004 from '../../../migrations/0004_bootstrap_org.sql';`.

```bash
make check-migrations
```

```bash
make backend-build
```

```bash
make tf-apply
```

The apply redeploys `db-migrate` because its `source_code_hash` changed. Then invoke it as in §7.

### The honest assessment of this step

Putting one company's identity into the repository's migration history is not clean. The
alternative designs are a bootstrap-only Lambda that takes an organisation payload, or an
`aws rds-data`-style path, and neither exists here. If you are deploying this for a second company
later, the migration approach does not generalise — you would want that endpoint first. It is
recorded here as the path that works with what is in the repository today, not as the path the
design should have.

Everything after the first owner is normal product usage: `POST /v1/employees` creates employees,
`POST /v1/users` creates further dashboard accounts against Cognito subs you create the same way,
and `POST /v1/devices/enrollment-tokens` mints enrolment tokens. All three are owner-scoped and
therefore require a second factor.

### Enrol a second factor now

Every `owner` and `manager` needs TOTP before they can reach any admin route. Pool MFA is
`OPTIONAL` rather than `REQUIRED` (deviation D7) so that an employee viewing their own timesheet is
not forced through TOTP; admin MFA is enforced server-side instead, by the `wl:mfa` claim the
pre-token trigger injects and the two-level gate in `backend/src/middleware/cognitoAuth.ts`. An
owner with no factor can sign in and reach `/v1/me` and the MFA-enrolment screen, and nothing else.

---

## 9. Step 7 — generate the environment files

Both targets read `terraform output`, so they only work after a successful apply, and they exit
non-zero with a clear message if there is no state. Renaming a Terraform output is a breaking
change for them — that is stated at the top of `infra/outputs.tf`.

```bash
make env-backend > backend/.env
```

```bash
make env-dashboard > dashboard/.env.local
```

Neither file goes into git; both `.env.example` templates are committed and document what every
variable is and where it comes from. Note that `backend/.env` is **not** how the deployed Lambdas
are configured — their environment comes from `infra/modules/lambda/main.tf`, and the one genuine
secret (the device root key) is never an environment variable at all, only an ARN the function
reads at run time. `backend/.env` is for the local migration CLI and local development.

### The generated files do not currently satisfy the code that reads them

Both `.env.example` templates have drifted from the schemas in `backend/src/shared/config.ts` and
`dashboard/src/lib/env.ts`, and the two `make env-*` targets generate files matching the *examples*.
**`docs/CONFIGURATION.md` §9 is the complete list**, including the backend variable-name mismatches
that make a generated `backend/.env` fail outright — `DB_APP_USER` where the code reads `DB_USER`,
`S3_SCREENSHOT_BUCKET` where it reads `SCREENSHOT_BUCKET`, and several more. Read that section before
you trust either generated file; do not treat `make env-backend > backend/.env` as finished.

The three that block the steps in *this* runbook specifically are below. They are recorded rather
than fixed, because fixing them is a code change and this is a document.

1. **`make env-dashboard` omits `NEXT_PUBLIC_APP_URL`, which the dashboard requires.**
   `dashboard/src/lib/env.ts` reads exactly four variables — `NEXT_PUBLIC_API_BASE_URL`,
   `NEXT_PUBLIC_COGNITO_DOMAIN`, `NEXT_PUBLIC_COGNITO_CLIENT_ID` and `NEXT_PUBLIC_APP_URL` — and
   `assertEnv()` throws naming any that are missing. The generated file supplies the first three.
   Append the fourth by hand; it must be the same origin as the single entry in
   `dashboard_origins`, because `callbackUrl` is built as `${appUrl}/api/auth/callback` and Cognito
   matches redirect URIs exactly — a trailing-slash difference is a failed login.

   ```bash
   echo "NEXT_PUBLIC_APP_URL=https://your-dashboard-host" >> dashboard/.env.local
   ```

2. **`make env-dashboard` emits two variables nothing reads**: `NEXT_PUBLIC_COGNITO_USER_POOL_ID`
   and `COGNITO_ISSUER_URL`. Harmless, but do not go looking for where they are consumed.

3. **`make env-backend` writes `DB_SSL_CA_PATH=infra/rds-ca-global-bundle.pem`, a file that does
   not exist.** There is no PEM in `infra/`; the committed trust store is
   `backend/assets/rds-ca-global-bundle.pem`. The migration CLI runs with `backend/` as its working
   directory and resolves the path as given, so the generated value points at
   `backend/infra/rds-ca-global-bundle.pem` and `verify-full` fails closed with a "no CA bundle was
   found" error. Edit `backend/.env` and blank the value — leave the key with nothing after the
   `=`. `migrate.ts` then falls back to `backend/assets/rds-ca-global-bundle.pem`, which is the
   file you want, and the fallback is why blanking is better than pointing the variable at the
   asset path by hand.

   ```bash
   grep -n DB_SSL_CA_PATH backend/.env
   ```

`make env-backend` also leaves `DB_PASSWORD=` empty, which is correct and deliberate: with no
password the CLI signs an RDS IAM token locally, with no network call. Set it only against a local
Postgres container, where IAM auth does not exist.

---

## 10. Step 8 — deploy the dashboard

```bash
make dashboard-build
```

That is `next build` in `dashboard/`. It is a standard Next.js production build with server
components and route handlers — the OAuth callback, login and logout live at
`dashboard/src/app/api/auth/*` and run server-side, because tokens are held in `httpOnly` cookies
and never reach client JavaScript (`docs/SECURITY.md` §2.9). It is therefore **not** a static
export and cannot be served from a bucket.

**This repository contains no hosting configuration.** There is no `vercel.json`, no Dockerfile, no
`output: 'standalone'` in `next.config.ts`, and no infrastructure in `infra/` that serves the
dashboard. `README.md` describes it as "a Next.js dashboard on Vercel", which is a statement of
intent rather than something the repository configures. Deploying it is yours to arrange: a Node
host running `next start` behind TLS, a container you build, or a platform that understands a Next
app. What the code requires of wherever it lands:

- **HTTPS**, because `next.config.ts` sets `Strict-Transport-Security` and the login flow sets
  secure cookies.
- **The origin must equal the single entry in `dashboard_origins`** and the value of
  `NEXT_PUBLIC_APP_URL`. That origin is what Terraform registered as the Cognito callback
  (`<origin>/api/auth/callback`) and logout (`<origin>/login`) URL, and as the API's one permitted
  CORS origin.
- **The four `NEXT_PUBLIC_*` variables at build time.** Next inlines them into the bundle, so they
  are baked in by `next build`, not read at run time. Changing the API URL or the Cognito client
  means rebuilding.

If you did not know the hostname when you wrote the tfvars, set it now and re-apply — the change
touches the api module's CORS responses, the storage module's CORS rule and the auth module's
callback URLs:

```bash
make tf-apply
```

The security headers in `next.config.ts` are worth not undoing on the way to production:
`X-Frame-Options: DENY` (clickjacking a payroll export or an erasure button is the specific attack),
`Referrer-Policy: no-referrer` (a full referrer would leak a presigned screenshot signature into the
logs of anything the browser subsequently talks to), and `Permissions-Policy` explicitly denying
camera and microphone, because "this product does not use your camera" is a promise the agent makes
and the dashboard should not quietly contradict.

---

## 11. Step 9 — build the agent

```bash
make agent-windows
```

Cross-compiles both binaries into `bin/` for `windows/amd64` with `CGO_ENABLED=0`,
`-trimpath` and `-ldflags "-s -w"`:

- `bin/worklens-agent.exe` — the thing that runs continuously in the employee's session.
- `bin/worklens-agentctl.exe` — install, enrol, diagnose. Separate on purpose: the long-running
  process has no code path that can install a scheduled task, write a credential or delete a
  buffer. The agent reads its configuration; only `agentctl` writes it.

`CGO_ENABLED=0` is not optional. It is what allows a single static `.exe` to be built from a Mac or
a Linux runner, and it is why the SQLite driver is `modernc.org/sqlite` (pure Go) rather than
`mattn/go-sqlite3` (cgo). Changing the driver would put a Windows C toolchain in the build path and
break cross-compilation entirely.

```bash
make agent-test
```

Runs the Go suite with `-race`. Note what this does and does not cover: all the logic is testable
off Windows, but `internal/platform/windows` is pure syscall and has no tests. **The Windows agent
has never run on Windows** — `docs/SECURITY.md` §4 says so and `docs/AGENT.md` §9 explains the
posture. Its correctness rests on cross-compilation, `GOOS=windows go vet`, and review. Treat the
first machine you install it on as a test, not a rollout.

Two build facts worth knowing before you hand a binary to somebody:

- **The binaries are unsigned.** There is no code-signing step in the Makefile or anywhere else in
  the repository. Windows SmartScreen will warn on first run of a downloaded executable, and on a
  managed fleet you will want to sign them or distribute them through a channel your endpoint
  policy trusts. Doing that is outside what this repository does.
- **`worklens-agentctl version` prints `dev`.** `main.go` declares `var version = "dev"` and
  `AGENT_LDFLAGS` is only `-s -w` — there is no `-X main.version=...`. The version is reported to
  the server at enrolment and on every heartbeat, so every device in the fleet will report `dev`
  until that is wired up. Not a functional problem; it does mean the dashboard's device list cannot
  answer "which build is this?" today.

---

## 12. Step 10 — roll the agent out to employee laptops

### Before any laptop

You should already have done the legal work in `docs/RESPONSIBLE_USE.md` §3 — told people, in
writing and in advance, before the agent is installed; established a lawful basis; obtained legal
sign-off for your jurisdiction. §4 of that document is an employee notice you can adapt for the
conversation *before* the software appears. Under the DPDP Act you are a Data Fiduciary and this
is not a step the software can perform on your behalf.

Preview the notice each employee will actually see, rendered from this installation's real
configuration rather than a generic template:

```bash
worklens-agentctl notice
```

Set the three notice fields in the agent's `config.json` before rolling out, or the notice names
nobody: `notice_org_name`, `notice_contact_name`, `notice_contact_email`, plus `dashboard_url` so
the notice can tell people where to see their own record. `worklens-agentctl doctor` warns when
they are absent. The file lives at `%LOCALAPPDATA%\WorkLens\config.json`, holds no secret, and is
the right thing to template into your deployment package.

### Per laptop

Copy both `.exe` files to the machine, then, **in the employee's own session** — not as SYSTEM, not
from an elevated deployment agent running as another user:

```bash
worklens-agentctl enroll --token wlen_... --api-url https://<api-id>.execute-api.ap-south-1.amazonaws.com/v1
```

The token comes from the dashboard, Settings > Devices, which calls
`POST /v1/devices/enrollment-tokens`. It is `wlen_` plus 32 bytes from a CSPRNG, only its SHA-256 is
stored, and **the response body is the only place it ever exists** — it is not logged at any level
and the audit entry records the token's row id rather than the token. It is single-use and has an
expiry. Re-enrolling an already-enrolled device is refused without `--force`, because it creates a
second device and splits the timesheet across both.

The device secret is never printed. It is derived server-side from the root key
(`HMAC-SHA256(root_key[v], "v<v>:<org_id>:<device_id>")`, `docs/SECURITY.md` §2.1) and written to
`credentials.json` at mode `0600` and nowhere else.

```bash
worklens-agentctl install
```

### This installs a logon Scheduled Task, not a Windows service — and that is not a preference

This is deviation D5, and it is the single most important structural fact about the agent
(`agent/cmd/worklens-agentctl/install.go`, `docs/AGENT.md` §2).

Windows services run in **session 0**, isolated from interactive desktops since Vista. From there
`GetForegroundWindow` returns the session-0 desktop's window (nothing a user is looking at),
`GetLastInputInfo` reports session-0 input (of which there is never any), and a screen capture
returns a blank frame. **A service-based agent would install cleanly, run without error, and report
every employee as permanently idle.** It would look like it worked. Every timesheet would be empty.

So `install` writes a task definition and registers it with
`schtasks /Create /TN "WorkLens Agent" /XML <file> /F`. The `/F` makes an upgrade a re-install
rather than an uninstall-then-install that leaves a window with no agent registered. The definition
is rendered as UTF-16LE with a BOM, because `schtasks` reads the encoding from the XML declaration
and rejects a mismatch with only "The task XML is malformed" to go on. `--print` renders UTF-8
instead, so the printed output can be redirected to a file and passed to `schtasks` directly — that
is the only combination that is both readable in a terminal and usable.

Inspect exactly what it will register, on any platform, without registering anything:

```bash
worklens-agentctl install --print
```

The settings that matter, and why:

| Setting | Value | Reason |
|---|---|---|
| `LogonTrigger` + `InteractiveToken` | 30 s delay | The only way to observe the desktop at all. |
| `RunLevel` | `LeastPrivilege` | The agent needs no elevation, and asking for it would make an employee's own machine something they control less. |
| `Hidden` | `false` | A hidden scheduled task is how covert monitoring software installs itself. |
| `StopIfGoingOnBatteries` | `false` | A laptop on battery is exactly when somebody is working. |
| `ExecutionTimeLimit` | `PT0S` | The default is 72 hours, after which Windows would kill the agent and the employee would silently stop being recorded. |
| `MultipleInstancesPolicy` | `IgnoreNew` | Two agents would double every event, and the server cannot deduplicate them — the client event ids differ, so both copies look legitimate. |
| `RestartOnFailure` | 3 × 1 min | Bounded crash recovery. A permanently crashing agent should stop rather than spin, and the absent tray icon then becomes the visible signal. |

Because the task runs as the enrolling user, `install` derives the principal from `USERDOMAIN` and
`USERNAME`. Run off Windows it registers nothing and says so plainly, rather than pretending to
succeed — a deployer scripting this on a build machine needs to know.

To start it without making the employee sign out:

```bash
schtasks /Run /TN "WorkLens Agent"
```

### The first-run notice is a gate, and a deployer must not bypass it

`cmd/worklens-agent/main.go` runs its startup in a fixed order, and the order is load-bearing
(`docs/AGENT.md` §3):

```
1. settings + paths          failures get reported to a real log
2. local buffer + recovery   release claims a previous crash left behind
3. credentials               absent → tray says "not set up", nothing is captured
4. THE NOTICE GATE           no capture goroutine exists until this passes
5. THE TRAY                  cannot be created → exit non-zero
6. capture / upload / housekeeping loops
```

Step 4 is not "start capturing and filter afterwards". An agent that captured first would already
have read the screen of somebody who had not been told. `notice.Outcome`'s zero value is
`OutcomeNotAcknowledged` and its `MayCapture()` is false, so a caller that ignores an error, or a
future early return, cannot accidentally produce an outcome that permits capture. Step 5 exits the
process, because an agent with no visible indicator is covert monitoring software.

There is no flag, environment variable or `agentctl` subcommand that skips the notice, and none
should be added. The only way to defeat it would be to pre-seed the acknowledgment in a laptop's
`buffer.db` before handing the machine over — which would produce a stored acknowledgment nobody
gave, destroy the evidentiary value of the record, and, under the DPDP Act's notice requirements,
be exactly the thing that makes a monitoring deployment indefensible. `docs/RESPONSIBLE_USE.md` §3
covers the obligation; the acknowledgment is a technical control that supports it, not a substitute
for it, and not a checkbox to be pre-ticked.

Expect, and do not treat as a fault, that:

- **Nothing is captured until the employee accepts.** `doctor` reports "Notice acknowledged: not
  yet — capture will not start", and adds "This is by design".
- **Nothing is captured outside working hours**, because `work_hours_only` is on by default.
- **Titles, URLs and screenshots are all off** until the agent has fetched the organisation's
  policy; the least-invasive defaults apply in the meantime.

All three are correct and all three are indistinguishable from "broken" to whoever deployed it,
which is why `doctor` exists.

There is also one break here that is **not** by design, and it matters at exactly this point in the
rollout: `docs/CONFIGURATION.md` §9.4 records that the agent mis-parses the `GET /v1/device/config`
response — the server nests the settings under a `config` key and the agent's unmarshaller expects
them at the top level, so `Validate()` rejects the payload and `pollConfig` logs "the monitoring
configuration is invalid; keeping the cached one". The failure direction is safe: the agent keeps
`LeastInvasiveConfig()` — titles off, URLs off, screenshots off, work-hours-only, 09:00–17:30
Mon–Fri. But it means **a monitoring policy set in the dashboard does not currently reach the
fleet**. Plan the rollout on that basis: the notice you preview with `worklens-agentctl notice`
renders from the cached policy, and until the parsing is fixed the cached policy is the
least-invasive default rather than whatever you configured. `doctor` surfaces it as "Monitoring
policy: none cached yet".

### Confirm the device

```bash
worklens-agentctl doctor
```

It exits non-zero on any failure, so a deployment script can gate on it. It checks the data
directory, the configuration, whether the notice details are complete, whether the notice can be
displayed on this platform, the TLS pin set, enrolment, the buffer (warning when the oldest unsent
event is over a day old, which is the single most useful thing it can surface), the notice
acknowledgment, whether a monitoring policy has been cached, the local clock against the server's
`Date` header, API reachability with a real TLS handshake against the configured pins, and the
scheduled task.

The clock check is there because a laptop 47 minutes fast otherwise presents as an unexplained
`401` — the signature window is ±300 s. The handshake is there because a pin mismatch behind a
corporate interception proxy only surfaces when the certificate is actually verified. If you are
behind such a proxy, add its authority to `tls_pins` rather than disabling pinning; the rollover
procedure is in `docs/SECURITY.md` §2.6. `WORKLENS_TLS_PINNING=off` exists for a deployment where
the alternative is an agent that does not work, and it logs a warning on every startup because a
silent downgrade would be worse than no pinning.

```bash
worklens-agentctl status
```

Shows what is configured and how far behind the buffer is. Neither command ever prints the device
secret.

---

## 13. Post-deploy verification

Tier by tier, so a failure localises.

### Terraform

```bash
terraform -chdir=infra output
```

Every output should be populated. `db_migrate_function_name` null means
`create_db_migrate_function` was set false and you have no way to reach the database.
`schedules_enabled` false means no timesheets will ever be produced.

### The alarm subscription

```bash
aws sns list-subscriptions-by-topic --region ap-south-1 --topic-arn $(terraform -chdir=infra output -raw alarm_topic_arn)
```

A subscription in `PendingConfirmation` means nobody clicked the AWS confirmation email, and the
alarms are decorative.

```bash
aws cloudwatch describe-alarms --region ap-south-1 --alarm-name-prefix worklens-prod --query 'MetricAlarms[].[AlarmName,StateValue]' --output table
```

`INSUFFICIENT_DATA` is the expected state for a stack with no traffic yet; it is not a failure.

### Database

```bash
aws lambda invoke --region ap-south-1 --function-name worklens-prod-db-migrate --cli-binary-format raw-in-base64-out --payload '{"action":"status"}' /dev/stdout
```

`pending` empty and `currentVersion` at your highest migration is the whole check. This
simultaneously proves that the VPC attachment works, that the security group admits the Lambda SG
on 5432, that Secrets Manager is reachable through its interface endpoint, and that `verify-full`
found the trust store in the deployment package.

### API and authorizer

```bash
curl -i $(terraform -chdir=infra output -raw api_base_url)/me
```

Expect **401** from the Cognito authorizer. A 401 is the pass: it proves the API exists, the stage
is deployed, the route is wired and the authorizer is attached. A 403 with a WAF body means WAF is
blocking you, which is also informative. A 404 means the resource tree or the deployment is wrong —
REST API deployments are immutable snapshots, and the classic failure is changing a method and
never redeploying.

Note that the gateway's own 401/403/429/5xx responses carry `Access-Control-Allow-Origin` because
the api module patches `DEFAULT_4XX` and `DEFAULT_5XX` gateway responses. Without that a 403 shows
up in the dashboard as an opaque network error rather than a status you can read.

### Logging

```bash
aws logs describe-log-groups --region ap-south-1 --log-group-name-prefix /aws/lambda/worklens-prod --query 'logGroups[].[logGroupName,retentionInDays,kmsKeyId]' --output table
```

Every group should have a retention (30 days by default — short on purpose, because application
logs can contain window titles) and a `kmsKeyId`. A group with neither was created implicitly by
Lambda rather than declared by Terraform, which is the failure the module exists to prevent.

### Authentication

Sign in at the hosted UI as the owner from §8, enrol TOTP, sign out and back in.

```bash
terraform -chdir=infra output -raw cognito_hosted_ui_domain
```

Then load the dashboard. Reaching `/overview` proves the whole chain: the hosted UI, the callback
route, the pre-token trigger reaching Postgres through the VPC and Cognito through its interface
endpoint, the `wl:*` claims, and the reporting API. If you land on `/mfa-required`, the `wl:mfa`
claim is `off` — the factor is not enrolled, or the token predates enrolling it.

If admin routes 403 while `/v1/me` works, the likely cause is the trigger finding no `users` row.
That case is deliberately not a hard failure: it issues a token with no `wl:` claims so the
dashboard can say something meaningful, and the API rejects every request made with it. Check the
`pre-token-generation` log group for "no users row for this identity".

### Ingest, end to end

The only complete test is a real device. On the laptop, after `doctor` reports healthy and the
employee has accepted the notice, wait for one upload interval, then:

```bash
worklens-agentctl status
```

`Last upload` set and the buffer at or near zero means signing, the nonce claim, ingest and the
per-device quota all work. Then confirm the row landed by opening that employee in the dashboard.

Screenshots, if you have enabled them, exercise a separate path — presign, direct S3 PUT pinned to
the CMK, then `screenshot-complete`. `docs/SECURITY.md` §4 notes the presigned-upload path has
never been tested against real S3, so treat the first screenshot as a test of that too.

### Aggregation

Timesheets are produced by the nightly job. Do not wait a day to find out whether it works:

```bash
curl -i -X POST -H "Authorization: Bearer <access-token>" $(terraform -chdir=infra output -raw api_base_url)/aggregation/run
```

`POST /v1/aggregation/run` points straight at `aggregate-timesheets` rather than being proxied
through `admin-api`, because an in-VPC function with no NAT gateway cannot reach the Lambda control
plane to invoke another function. The consequence is that this route's RBAC check lives in the
aggregation function rather than alongside the other admin routes.

Then turn the schedules on, if you set `enable_schedules = false` for the first apply:

```bash
make tf-apply
```

```bash
terraform -chdir=infra output schedule_expressions
```

The three schedules are `aggregate-timesheets` (`cron(45 20 * * ? *)` — 20:45 UTC, which is 02:15
IST, after the end of an Indian working day and before anyone opens a dashboard),
`retention-sweeper` (`cron(0 22 * * ? *)`, offset from aggregation on purpose so the two are never
reading and deleting the same rows at once) and `nonce-sweeper` (`rate(1 hour)`). EventBridge cron
is always UTC; per-employee day boundaries are computed in each employee's own timezone inside the
job, so the expression only sets when the work runs. Aggregation looks back three days by default,
because an agent offline overnight uploads yesterday's events today and that late data has to land
in the right day's timesheet — the rollup is an idempotent upsert, so recomputing a settled day
costs only CPU.

A failed scheduled run lands in the dead-letter queue, and there is an alarm on the queue being
non-empty:

```bash
aws sqs get-queue-attributes --region ap-south-1 --queue-url $(terraform -chdir=infra output -raw schedule_dead_letter_queue_url) --attribute-names ApproximateNumberOfMessages
```

A non-empty queue means a job failed. Anything other than `0` needs investigation.

---

## 14. Redeploying

### Lambda code only

```bash
make backend-build
```

```bash
make tf-apply
```

The plan shows a diff only for functions whose zip hash changed. **A stale zip produces no diff** —
if the build did not run, or wrote a byte-identical zip, `apply` reports no changes and the old code
stays deployed. That is the trap the modules' READMEs warn about, and the reason the build is a
separate step you can forget.

If the change includes a new migration, invoke `db-migrate` after the apply, not before: the
function has to be carrying the new SQL.

### The agent

`make agent-windows`, then redistribute. `worklens-agentctl install` replaces the existing task via
`/F`, so an upgrade is a re-install and there is never a window with the task deregistered. A
running agent keeps running until the employee signs out or quits it from the tray.

### The dashboard

`make dashboard-build` and redeploy. Remember the `NEXT_PUBLIC_*` values are inlined at build time,
so a changed API URL needs a rebuild, not a restart.

---

## 15. Rollback

There is no one-command rollback, and it is better to say so than to imply one.

**Infrastructure.** Terraform's rollback is `git revert` on the configuration plus another apply.
The state bucket is versioned, so a corrupted or truncated state file is recoverable from S3
versioning for 90 days — which is the entire reason versioning is on, and why it had to be in place
before the damage rather than after.

**Lambda code.** Rebuild from the previous commit and apply. Terraform manages `$LATEST` and does
not publish versions or aliases, so there is no "shift the alias back" move available; the rollback
is a redeploy of older bytes.

**Database.** Migrations are **forward-only**. There is no `down` migration and no rollback
mechanism; the runner has an advisory lock, checksums, gap detection and atomic application, and
none of that includes reversal. `verifyIntegrity` will refuse to proceed if a previously applied
file's checksum has changed, which is what stops somebody editing history in place. The recovery
paths are:

- **Correct forward** with a new migration. This is the intended answer.
- **Point-in-time recovery.** Automated backups are on with 7-day retention by default and PITR is
  enabled, so restoring to a timestamp before a destructive migration is possible — as a *new*
  instance, which then has to be swapped in by changing `DB_HOST` for every function. Terraform
  does not model that restore; it is a console or CLI operation.

**Cognito.** The pool has `deletion_protection` on by default, separate from the database's, for
the reason its variable gives: losing the pool means every dashboard account is recreated and every
user re-enrols MFA, which is a different kind of loss and should not be turned off as a side effect
of tearing down a database.

**Agent.** `worklens-agentctl uninstall` deregisters the task; `unenroll` deletes the credential and
the local buffer. Do both in that order on a machine you are pulling the agent from. `unenroll`
deletes `buffer.db`, its WAL and SHM files, and the screenshot queue unless you pass
`--keep-buffer`, because the buffer holds window titles and leaving it behind would leave personal
data on the machine with nothing that will ever upload or delete it.

---

## 16. Teardown

Tearing this down is not `terraform destroy` on its own. Four things block it, three of them on
purpose.

### 1. RDS deletion protection

`deletion_protection` defaults to `true` and is enforced by RDS itself rather than by Terraform,
which is the point — it also blocks a deletion attempted from the console or the CLI. Note that
`prevent_destroy` on the instance is deliberately `false`, and the module explains why:
`prevent_destroy` cannot be driven by a variable, so setting it would make a legitimate teardown of
a staging stack require editing a shared module, and somebody editing a shared module to delete
their own environment is worse than the protection is worth.

Set `db_deletion_protection = false` in `infra/terraform.tfvars`, then apply to clear the flag
before destroying:

```bash
make tf-apply
```

### 2. The final snapshot, and why its name has a random suffix

`infra/modules/database/main.tf` sets:

```
skip_final_snapshot       = false
final_snapshot_identifier = "${var.name_prefix}-pg-final-${random_id.final_snapshot.hex}"
```

`skip_final_snapshot = false` is deliberate: a production database should not be deletable without a
copy. The suffix is there because the identifier used to be the bare `${var.name_prefix}-pg-final`,
which is not unique per destroy — destroying `worklens-prod` left the snapshot
`worklens-prod-pg-final`, and standing the same environment up and destroying it a second time
failed with `DBSnapshotAlreadyExists`. That failure arrives at the *last* step of a destroy, after
every other resource has already gone, and the only way out is deleting the previous snapshot by
hand while a half-destroyed stack sits in state. Deciding whether a backup is expendable is not a
decision anybody should be making under that pressure.

The suffix comes from `random_id.final_snapshot`, which is generated once and held in Terraform
state. `timestamp()` would have worked too and was rejected: it is evaluated at plan time, so it
shows as a perpetual diff on a database nobody has touched, and a resource that always appears
changed is a resource whose real changes stop being noticed.

Two consequences worth knowing before a teardown:

- **Snapshots accumulate.** Each destroy leaves one, and none of them expires on its own. Listing
  them is the only way to see what you are paying for:

  ```bash
  aws rds describe-db-snapshots --region ap-south-1 --snapshot-type manual --query "DBSnapshots[?starts_with(DBSnapshotIdentifier, 'worklens-prod-pg-final')].[DBSnapshotIdentifier,SnapshotCreateTime,AllocatedStorage]" --output table
  ```

- **The suffix regenerates when the instance would be replaced**, via the `keepers` block, so a
  snapshot name always belongs to the database it was taken from rather than to whatever instance
  happened to occupy that identifier later.

### 3. Non-empty S3 buckets

Both the screenshot bucket and the CloudTrail bucket are declared with `force_destroy = false`, so
Terraform cannot empty them as a side effect of a destroy. A destroy fails while any object
remains. Both are versioned, so "empty" means every version and every delete marker. Emptying them
is a deliberate act you perform yourself — the screenshot bucket contains images of people's
screens, and this document is not going to hand you a recursive delete for it. Do it through the
console's "Empty bucket" flow, or a scripted `list-object-versions` and `delete-objects` loop you
have read carefully, and only after you are certain the retention obligations in
`docs/RESPONSIBLE_USE.md` permit it.

### 4. Cognito deletion protection

`cognito_deletion_protection` defaults to `true`. Set it false and apply before destroying, on the
same principle as the database flag.

### Then

```bash
terraform -chdir=infra destroy -var-file=terraform.tfvars
```

The three KMS CMKs are *scheduled* for deletion rather than deleted, on a 30-day window by default
(`kms_deletion_window_days`, validated to 7–30). Until that window elapses the keys still exist,
which means the RDS snapshot and any objects encrypted with them are still readable — and also
means re-creating the stack in the same account does not reuse them.

### The bootstrap stack is last, and resists

Both the state bucket and the lock table carry `prevent_destroy`, so `terraform destroy` in
`infra/bootstrap` fails by design. Removing the backend that holds your state is not something a
stray command should manage. If you genuinely mean it, edit `infra/bootstrap/main.tf` to drop the
two `lifecycle` blocks, empty the versioned bucket by hand, and destroy — in that order. And keep
in mind that the root stack's state has to be gone or irrelevant first, because destroying the
bucket while the root stack still has resources leaves you with infrastructure Terraform no longer
knows about, which is days of reconciliation by hand.

---

## 17. What this runbook cannot tell you

Stated plainly, because a deployment document that only lists successes is not useful.

- **No `apply` has ever run.** Every command here is derived from the configuration and the scripts
  it calls. `terraform validate` passes for both stacks and `make ci` passes locally; that is a
  different claim from "this works".
- **The IAM policy the applying principal needs is derived, not observed.** §1 lists the services
  the resources in `infra/` touch. Nobody has run an apply and collected the actual denied actions,
  so a least-privilege policy built from that list will probably be missing something.
- **The Windows agent has never executed on Windows.** The Win32 syscall layer cross-compiles and
  passes `GOOS=windows go vet`, and `internal/platform/windows` has no tests because it is pure
  syscall. Screenshot capture in particular is tested only with fakes.
- **The presigned upload path has not been exercised against real S3**, and neither have the WAF
  rules against real traffic. The bucket policy denies a `PutObject` without the SSE-KMS header, so
  a mismatch between the presign conditions and what the agent actually sends would surface as an
  upload that fails with a 403 — the first screenshot is the test.
- **Timings are unmeasured.** How long the first apply takes, how long the RDS instance takes to
  become available, whether the 300-second `db-migrate` timeout is comfortable for `0001_init.sql`
  on a `db.t4g.micro` — all unknown. `0001` creates 22 tables and their indexes against an empty
  database, so it should be fast, but "should be" is the operative phrase.
- **No load testing.** `db.t4g.micro` is sized from an estimate: ingest is one batched write per
  device per minute, not a per-request workload, and the ~85-connection ceiling is why
  `DB_POOL_MAX=1` and `ingest_reserved_concurrency = 20` exist. Whether that holds at a few hundred
  devices has not been measured.
- **No penetration test or external review.**
- **One doc this file would like to reference does not exist yet.** OPERATIONS.md, under `docs/`,
  is referenced from `infra/outputs.tf`, `infra/variables.tf`, `infra/terraform.tfvars.example`,
  two module READMEs, `README.md`, `docs/PLAN.md`, `docs/ARCHITECTURE.md` and `docs/SECURITY.md`,
  and has not been written. Where this runbook would have deferred to it — RDS scale-up past a few
  hundred devices, device root key rotation, what to do about a non-empty dead-letter queue — it
  says what it can and otherwise says nothing, rather than pointing at a file that is not there.
  `scripts/check-docs.sh` currently fails on those four remaining references, which is the gate
  working as intended.
