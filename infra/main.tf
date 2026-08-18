# ---------------------------------------------------------------------------
# WorkLens — root stack.
#
# One `terraform apply` brings up the entire backend. Module order below follows the
# dependency graph rather than any logical grouping, so reading top to bottom is also
# reading the order things come up in.
#
# Two dependencies are passed as *computed strings* rather than module outputs, because
# taking them as outputs would create a cycle:
#
#   storage needs the CloudTrail ARN for its bucket policy, and observability needs the
#   screenshot bucket ARN for the trail's data-event selector. Both are derivable from
#   the account, region and name prefix, so both are built in locals below.
#
# See docs/PLAN.md for the design and the ten justified deviations, and
# docs/ARCHITECTURE.md for how the pieces interact at runtime.
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

# S3 bucket names are global, so a fixed name would collide with anyone else who has ever
# deployed WorkLens. A short random suffix is generated once and kept in state for the
# lifetime of the stack.
resource "random_id" "suffix" {
  byte_length = 4
}

locals {
  name_prefix = "${var.project}-${var.environment}"
  account_id  = data.aws_caller_identity.current.account_id
  partition   = data.aws_partition.current.partition
  suffix      = random_id.suffix.hex

  common_tags = merge(
    {
      Project     = var.project
      Environment = var.environment
      ManagedBy   = "terraform"
      Repository  = "worklens"
    },
    var.extra_tags,
  )

  # ---- names and ARNs computed to break the storage/observability cycle ----
  screenshot_bucket_name = "${local.name_prefix}-screenshots-${local.suffix}"
  cloudtrail_bucket_name = "${local.name_prefix}-cloudtrail-${local.suffix}"
  cloudtrail_name        = "${local.name_prefix}-trail"

  screenshot_bucket_arn = "arn:${local.partition}:s3:::${local.screenshot_bucket_name}"
  cloudtrail_arn        = "arn:${local.partition}:cloudtrail:${var.aws_region}:${local.account_id}:trail/${local.cloudtrail_name}"

  # The hosted-UI domain must be unique across the region. Deriving it from the same
  # random suffix keeps a first apply from failing on a name someone else has taken.
  cognito_domain_prefix = coalesce(var.cognito_domain_prefix, "${local.name_prefix}-${local.suffix}")

  # Cognito requires exact redirect URIs, not origins.
  cognito_callback_urls = [for origin in var.dashboard_origins : "${origin}/api/auth/callback"]
  cognito_logout_urls   = [for origin in var.dashboard_origins : "${origin}/login"]
}

# ---------------------------------------------------------------------------
# 1. Keys, trail, secret and alarms
# ---------------------------------------------------------------------------
# First, because almost everything else encrypts with one of its CMKs.

module "observability" {
  source = "./modules/observability"

  name_prefix = local.name_prefix
  tags        = local.common_tags

  cloudtrail_bucket_name           = local.cloudtrail_bucket_name
  cloudtrail_name                  = local.cloudtrail_name
  enable_cloudtrail_s3_data_events = var.enable_cloudtrail_s3_data_events
  screenshot_bucket_arn            = local.screenshot_bucket_arn

  alarm_email = var.alarm_email
}

# ---------------------------------------------------------------------------
# 2. Network
# ---------------------------------------------------------------------------
# No NAT gateway (deviation D6). Reachability out of the private subnets comes from a
# free S3 gateway endpoint plus two interface endpoints: Secrets Manager for the device
# root key, and Cognito for the pre-token-generation trigger's AdminGetUser call.

module "network" {
  source = "./modules/network"

  name_prefix = local.name_prefix
  tags        = local.common_tags

  vpc_cidr                    = var.vpc_cidr
  availability_zone_count     = 2
  database_port               = 5432
  enable_cognito_vpc_endpoint = true

  enable_flow_logs        = var.enable_vpc_flow_logs
  flow_log_retention_days = var.log_retention_days
  logs_kms_key_arn        = module.observability.logs_kms_key_arn
}

# ---------------------------------------------------------------------------
# 3. Buckets
# ---------------------------------------------------------------------------

module "storage" {
  source = "./modules/storage"

  name_prefix = local.name_prefix
  tags        = local.common_tags

  screenshot_bucket_name = local.screenshot_bucket_name
  cloudtrail_bucket_name = local.cloudtrail_bucket_name
  cloudtrail_arn         = local.cloudtrail_arn

  s3_kms_key_arn   = module.observability.s3_kms_key_arn
  s3_kms_key_id    = module.observability.s3_kms_key_id
  logs_kms_key_arn = module.observability.logs_kms_key_arn

  screenshot_retention_days = var.screenshot_retention_days
  cloudtrail_retention_days = var.cloudtrail_retention_days

  # The dashboard reads screenshots through presigned GETs, and the agent PUTs directly
  # to presigned URLs. The agent is not a browser and sends no Origin header, so it needs
  # no CORS entry; the dashboard does.
  dashboard_origins    = var.dashboard_origins
  agent_upload_origins = []
}

# ---------------------------------------------------------------------------
# 4. Database
# ---------------------------------------------------------------------------

module "database" {
  source = "./modules/database"

  name_prefix = local.name_prefix
  tags        = local.common_tags

  subnet_ids             = module.network.private_subnet_ids
  vpc_security_group_ids = [module.network.rds_security_group_id]
  database_port          = 5432

  kms_key_arn      = module.observability.rds_kms_key_arn
  logs_kms_key_arn = module.observability.logs_kms_key_arn

  instance_class        = var.db_instance_class
  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage

  multi_az                = var.db_multi_az
  backup_retention_period = var.db_backup_retention_days
  deletion_protection     = var.db_deletion_protection
  log_retention_days      = var.log_retention_days
}

# ---------------------------------------------------------------------------
# 5. Functions
# ---------------------------------------------------------------------------
# Every function gets its own role and its own inline policies; the module makes a
# function without a role impossible to declare. Artifacts come from
# `make backend-build`, which reads the same inventory in backend/functions.json.

module "lambda" {
  source = "./modules/lambda"

  name_prefix = local.name_prefix
  tags        = local.common_tags
  environment = var.environment

  artifact_dir = var.lambda_artifact_dir
  runtime      = "nodejs22.x"
  architecture = "arm64"
  log_level    = var.lambda_log_level

  log_retention_days = var.log_retention_days
  log_kms_key_arn    = module.observability.logs_kms_key_arn

  subnet_ids         = module.network.private_subnet_ids
  security_group_ids = [module.network.lambda_security_group_id]

  db_host                   = module.database.address
  db_port                   = module.database.port
  db_name                   = module.database.db_name
  db_user                   = module.database.app_db_username
  db_iam_auth_resource_arn  = module.database.iam_auth_resource_arn
  db_master_user_secret_arn = module.database.master_user_secret_arn
  rds_kms_key_arn           = module.observability.rds_kms_key_arn

  device_root_key_secret_arn = module.observability.device_root_key_secret_arn

  screenshot_bucket_name = module.storage.screenshot_bucket_id
  screenshot_bucket_arn  = module.storage.screenshot_bucket_arn
  screenshot_prefix      = module.storage.screenshot_object_prefix
  s3_kms_key_arn         = module.observability.s3_kms_key_arn

  ingest_reserved_concurrency = var.ingest_reserved_concurrency
  hmac_timestamp_skew_seconds = var.hmac_timestamp_skew_seconds
  create_db_migrate_function  = var.create_db_migrate_function
}

# ---------------------------------------------------------------------------
# 6. Authentication
# ---------------------------------------------------------------------------
# Pool MFA is OPTIONAL rather than REQUIRED (deviation D7): forcing TOTP on every
# employee just to see their own timesheet is the wrong trade, so admin MFA is enforced
# server-side instead — the pre-token-generation trigger injects a wl:mfa claim and the
# API rejects admin routes without it.

module "auth" {
  source = "./modules/auth"

  name_prefix = local.name_prefix
  tags        = local.common_tags

  domain_prefix = local.cognito_domain_prefix
  callback_urls = local.cognito_callback_urls
  logout_urls   = local.cognito_logout_urls

  advanced_security_mode = var.cognito_advanced_security_mode
  deletion_protection    = var.db_deletion_protection

  pre_token_generation_lambda_arn           = module.lambda.pre_token_generation_function_arn
  pre_token_generation_lambda_function_name = module.lambda.pre_token_generation_function_name
  pre_token_generation_role_name            = module.lambda.pre_token_generation_role_name
  admin_api_role_name                       = module.lambda.admin_api_role_name
}

# ---------------------------------------------------------------------------
# 7. API
# ---------------------------------------------------------------------------
# REST API rather than HTTP API (deviation D2): AWS WAF cannot be attached to an HTTP
# API, and WAF is a Section 9 security requirement.

module "api" {
  source = "./modules/api"

  name_prefix = local.name_prefix
  tags        = local.common_tags

  stage_name     = var.api_stage_name
  invoke_arns    = module.lambda.invoke_arns
  function_names = module.lambda.function_names

  device_authorizer_invoke_arn = module.lambda.device_authorizer_invoke_arn
  cognito_user_pool_arn        = module.auth.user_pool_arn

  throttle_rate_limit  = var.api_throttle_rate_limit
  throttle_burst_limit = var.api_throttle_burst_limit
  data_trace_enabled   = var.api_data_trace_enabled

  cors_allowed_origins = var.dashboard_origins

  custom_domain_name  = var.api_custom_domain_name
  acm_certificate_arn = var.api_acm_certificate_arn
  log_retention_days  = var.log_retention_days
  log_kms_key_arn     = module.observability.logs_kms_key_arn
}

# ---------------------------------------------------------------------------
# 8. WAF
# ---------------------------------------------------------------------------

module "waf" {
  source = "./modules/waf"

  name_prefix = local.name_prefix
  tags        = local.common_tags

  api_stage_arn = module.api.stage_arn

  rate_limit_per_five_minutes        = var.waf_rate_limit_per_five_minutes
  enroll_rate_limit_per_five_minutes = var.waf_enroll_rate_limit_per_five_minutes
  common_rule_set_count_only         = var.waf_count_only

  log_retention_days = var.log_retention_days
  log_kms_key_arn    = module.observability.logs_kms_key_arn
}

# ---------------------------------------------------------------------------
# 9. Schedules
# ---------------------------------------------------------------------------

module "scheduling" {
  source = "./modules/scheduling"

  name_prefix = local.name_prefix
  tags        = local.common_tags
  enabled     = var.enable_schedules

  aggregate_timesheets_function_arn  = module.lambda.aggregate_timesheets_function_arn
  aggregate_timesheets_function_name = module.lambda.aggregate_timesheets_function_name
  retention_sweeper_function_arn     = module.lambda.retention_sweeper_function_arn
  retention_sweeper_function_name    = module.lambda.retention_sweeper_function_name
  nonce_sweeper_function_arn         = module.lambda.nonce_sweeper_function_arn
  nonce_sweeper_function_name        = module.lambda.nonce_sweeper_function_name

  aggregation_schedule_expression = var.aggregation_schedule_expression
  aggregation_lookback_days       = var.aggregation_lookback_days

  alarm_topic_arn = module.observability.alarm_topic_arn
}

# ---------------------------------------------------------------------------
# 10. Alarms
# ---------------------------------------------------------------------------
# Last, because every alarm watches something created above. This is also why alarms are
# a separate module from observability: observability's CMKs are needed by the database
# and the functions, so a module that both provided keys and consumed function names
# would depend on the resources depending on it.

module "alarms" {
  source = "./modules/alarms"

  name_prefix = local.name_prefix
  tags        = local.common_tags

  alarm_topic_arn = module.observability.alarm_topic_arn

  lambda_function_names = module.lambda.function_names
  ingest_function_name  = module.lambda.function_names["ingest-events"]

  rds_instance_id          = module.database.instance_id
  rds_allocated_storage_gb = var.db_allocated_storage
}

# ---------------------------------------------------------------------------
# Build/deploy consistency check
# ---------------------------------------------------------------------------
# The one thing that silently produces a broken deployment is a function whose zip was
# never built: Terraform would fail on a missing file, but only after creating half the
# stack. This check fails the plan instead, naming the exact missing artifacts.

check "lambda_artifacts_present" {
  assert {
    condition = alltrue([
      for zip in module.lambda.expected_artifacts :
      fileexists("${var.lambda_artifact_dir}/${zip}")
    ])
    error_message = join(" ", [
      "Missing Lambda deployment package(s) in ${var.lambda_artifact_dir}:",
      join(", ", [
        for zip in module.lambda.expected_artifacts :
        zip if !fileexists("${var.lambda_artifact_dir}/${zip}")
      ]),
      "— run `make backend-build` first.",
    ])
  }
}
