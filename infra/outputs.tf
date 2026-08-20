# ---------------------------------------------------------------------------
# Outputs.
#
# Grouped by who consumes them. `make env-backend` and `make env-dashboard` read these
# to generate the .env files, so an output being renamed here is a breaking change for
# those targets — see the Makefile.
# ---------------------------------------------------------------------------

# --- API -------------------------------------------------------------------

output "api_base_url" {
  description = "Base URL for every API call. This is WORKLENS_API_BASE_URL for the agent and NEXT_PUBLIC_API_BASE_URL for the dashboard."
  value       = module.api.api_base_url
}

output "api_id" {
  description = "REST API id, for CloudWatch metric dimensions and the AWS console."
  value       = module.api.rest_api_id
}

output "api_stage_name" {
  description = "Deployed stage name."
  value       = module.api.stage_name
}

output "api_custom_domain_target" {
  description = "Regional domain name to point a CNAME at, when a custom domain is configured. Null otherwise."
  value       = module.api.custom_domain_regional_domain_name
}

# --- Authentication --------------------------------------------------------

output "cognito_user_pool_id" {
  description = "Cognito user pool id."
  value       = module.auth.user_pool_id
}

output "cognito_client_id" {
  description = "Cognito app client id used by the dashboard. Public by design — the client has no secret and uses the authorisation-code flow with PKCE."
  value       = module.auth.client_id
}

output "cognito_hosted_ui_domain" {
  description = "Hosted-UI domain that serves the login page."
  value       = module.auth.hosted_ui_domain
}

output "cognito_issuer_url" {
  description = "OIDC issuer URL, for verifying tokens and configuring the dashboard's auth library."
  value       = module.auth.user_pool_issuer_url
}

output "cognito_groups" {
  description = "The RBAC groups created in the pool. A user's group is the role the API enforces."
  value       = module.auth.group_names
}

# --- Database --------------------------------------------------------------

output "rds_endpoint" {
  description = "RDS endpoint including the port."
  value       = module.database.endpoint
}

output "rds_address" {
  description = "RDS hostname without the port. This is DB_HOST."
  value       = module.database.address
}

output "rds_port" {
  description = "RDS port."
  value       = module.database.port
}

output "rds_db_name" {
  description = "Database name. This is DB_NAME."
  value       = module.database.db_name
}

output "rds_app_username" {
  description = "Role the Lambdas connect as, via IAM authentication. Created by migration 0003."
  value       = module.database.app_db_username
}

output "rds_master_username" {
  description = "Master username. Migrations run as this role, because migration 0003 grants rds_iam and only rds_superuser can do that."
  value       = module.database.master_username
}

output "rds_master_user_secret_arn" {
  description = "ARN of the RDS-managed master credential in Secrets Manager. The password itself is never in Terraform state."
  value       = module.database.master_user_secret_arn
}

# --- Storage ---------------------------------------------------------------

output "s3_screenshot_bucket" {
  description = "Screenshot bucket name. This is S3_SCREENSHOT_BUCKET."
  value       = module.storage.screenshot_bucket_id
}

output "s3_screenshot_prefix" {
  description = "Key prefix screenshot objects are written under."
  value       = module.storage.screenshot_object_prefix
}

output "s3_cloudtrail_bucket" {
  description = "CloudTrail log bucket name."
  value       = module.storage.cloudtrail_bucket_id
}

# --- Secrets and keys ------------------------------------------------------

output "device_root_key_secret_arn" {
  description = <<-EOT
    ARN of the device root key. Per-device secrets are DERIVED from this rather than
    stored, so no device credential exists in the database — see docs/PLAN.md deviation D4.
    This is DEVICE_ROOT_KEY_SECRET_ARN.
  EOT
  value       = module.observability.device_root_key_secret_arn
}

output "s3_kms_key_arn" {
  description = "CMK encrypting screenshot objects. Presigned uploads are pinned to it."
  value       = module.observability.s3_kms_key_arn
}

output "rds_kms_key_arn" {
  description = "CMK encrypting RDS storage, snapshots and the Secrets Manager secrets."
  value       = module.observability.rds_kms_key_arn
}

# --- Networking ------------------------------------------------------------

output "vpc_id" {
  description = "VPC id."
  value       = module.network.vpc_id
}

output "private_subnet_ids" {
  description = "Private subnets the database and the in-VPC functions live in."
  value       = module.network.private_subnet_ids
}

output "lambda_security_group_id" {
  description = "Security group attached to in-VPC functions; the only source RDS accepts on 5432."
  value       = module.network.lambda_security_group_id
}

# --- Operations ------------------------------------------------------------

output "lambda_function_names" {
  description = "Every deployed function, keyed by logical name."
  value       = module.lambda.function_names
}

output "db_migrate_function_name" {
  description = <<-EOT
    The in-VPC migration function. RDS has no public access, so invoking this is how
    migrations reach the deployed database:
      aws lambda invoke --function-name <this> --payload '{}' /dev/stdout
  EOT
  value       = module.lambda.db_migrate_function_name
}

output "schedule_expressions" {
  description = "The cron/rate expression in force for each background job."
  value       = module.scheduling.schedule_expressions
}

output "schedules_enabled" {
  description = "Whether background jobs are currently firing."
  value       = module.scheduling.enabled
}

output "schedule_dead_letter_queue_url" {
  description = "Queue holding scheduled invocations that exhausted their retries. A non-empty queue means a job failed — see docs/OPERATIONS.md."
  value       = module.scheduling.dead_letter_queue_url
}

output "waf_web_acl_arn" {
  description = "WAF WebACL protecting the API stage."
  value       = module.waf.web_acl_arn
}

output "alarm_topic_arn" {
  description = "SNS topic alarms publish to. Subscribe an address by setting alarm_email, then confirm the email AWS sends."
  value       = module.observability.alarm_topic_arn
}

output "alarm_names" {
  description = "Every alarm watching this stack."
  value       = module.alarms.alarm_names
}

# --- Deploy summary --------------------------------------------------------

output "dashboard_url" {
  description = <<-EOT
    The dashboard's own origin, which is the first (and, per the api module's validation, only)
    entry in dashboard_origins.

    Output so `make env-dashboard` can emit NEXT_PUBLIC_APP_URL from Terraform rather than leaving a
    deployer to type it. src/lib/env.ts refuses to start without it, and the OAuth callback is built
    by appending /api/auth/callback to it — Cognito matches redirect URIs exactly, so a
    value that disagrees with this one by a trailing slash is a login that fails with nothing useful
    in any log.
  EOT
  value       = var.dashboard_origins[0]
}

output "next_steps" {
  description = "What to do after a successful apply. Printed so the deploy path does not depend on remembering the docs."
  value       = <<-EOT

    WorkLens ${var.environment} is up in ${var.aws_region}.

    1. Apply the database migrations. RDS is in a private subnet with no public access,
       so this runs from inside the VPC:

           aws lambda invoke \
             --region ${var.aws_region} \
             --function-name ${coalesce(module.lambda.db_migrate_function_name, "<db-migrate disabled>")} \
             --payload '{}' /dev/stdout

    2. Create the organisation and the first owner account. See docs/DEPLOYMENT.md.

    3. Write the service environment files from these outputs:

           make env-backend   > backend/.env
           make env-dashboard > dashboard/.env.local

    4. Point the dashboard at ${module.api.api_base_url} and log in through
       ${module.auth.hosted_ui_domain}.

    5. Enrol a device: generate a token in Settings > Devices, then on the laptop run
           worklens-agentctl enroll --token wlen_...

    ${var.alarm_email == null ? "WARNING: alarm_email is unset, so alarms fire into an unsubscribed topic. Set it before treating this as production." : "Alarms notify ${var.alarm_email} — confirm the AWS subscription email."}
    ${var.enable_schedules ? "Background jobs are enabled." : "NOTE: schedules are disabled (enable_schedules = false). No timesheets will be produced until you enable them."}

  EOT
}
