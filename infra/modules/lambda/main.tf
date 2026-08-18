# ---------------------------------------------------------------------------
# Every WorkLens Lambda function.
#
# Each entry in local.functions becomes one invocation of ./modules/function,
# which gives it its own IAM role, its own inline policies and its own
# KMS-encrypted log group. Adding a function without a role is therefore not
# possible by construction.
#
# Data-plane functions run inside the VPC private subnets. pre-token-generation
# runs outside the VPC on purpose: it calls the Cognito API, and with no NAT
# gateway (docs/PLAN.md D6) an in-VPC function could not reach it.
# ---------------------------------------------------------------------------

data "aws_region" "current" {}

locals {
  region = data.aws_region.current.name

  screenshot_objects_arn = "${var.screenshot_bucket_arn}/${var.screenshot_prefix}*"

  # ---- shared environment ------------------------------------------------
  base_env = {
    ENVIRONMENT  = var.environment
    LOG_LEVEL    = var.log_level
    NODE_OPTIONS = "--enable-source-maps"
  }

  db_env = {
    DB_HOST     = var.db_host
    DB_PORT     = tostring(var.db_port)
    DB_NAME     = var.db_name
    DB_USER     = var.db_user
    DB_IAM_AUTH = "true"
    DB_SSL_MODE = "verify-full"
  }

  bucket_env = {
    SCREENSHOT_BUCKET      = var.screenshot_bucket_name
    SCREENSHOT_PREFIX      = var.screenshot_prefix
    S3_KMS_KEY_ARN         = var.s3_kms_key_arn
    PRESIGN_EXPIRY_SECONDS = tostring(var.presign_expiry_seconds)
  }

  device_auth_env = {
    DEVICE_ROOT_KEY_SECRET_ARN  = var.device_root_key_secret_arn
    HMAC_TIMESTAMP_SKEW_SECONDS = tostring(var.hmac_timestamp_skew_seconds)
    NONCE_RETENTION_SECONDS     = tostring(var.nonce_retention_seconds)
  }

  # ---- reusable IAM statements -------------------------------------------
  # Every statement carries the same attribute set (sid/actions/resources/
  # conditions) so the function catalogue below stays a homogeneous map.
  stmt_db_connect = {
    sid        = "RdsIamConnect"
    actions    = ["rds-db:connect"]
    resources  = [var.db_iam_auth_resource_arn]
    conditions = []
  }

  stmt_read_root_key = {
    sid = "ReadDeviceRootKey"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources  = [var.device_root_key_secret_arn]
    conditions = []
  }

  stmt_read_master_secret = {
    sid = "ReadDatabaseMasterCredential"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources  = [var.db_master_user_secret_arn]
    conditions = []
  }

  stmt_decrypt_secrets = {
    sid       = "DecryptSecretsManagerCiphertext"
    actions   = ["kms:Decrypt"]
    resources = [var.rds_kms_key_arn]
    conditions = [{
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${local.region}.amazonaws.com"]
    }]
  }

  stmt_s3_put_screenshot = {
    sid        = "PutScreenshotObjects"
    actions    = ["s3:PutObject"]
    resources  = [local.screenshot_objects_arn]
    conditions = []
  }

  stmt_s3_get_screenshot = {
    sid = "ReadScreenshotObjects"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources  = [local.screenshot_objects_arn]
    conditions = []
  }

  stmt_s3_delete_screenshot = {
    sid = "DeleteScreenshotObjects"
    actions = [
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
    ]
    resources  = [local.screenshot_objects_arn]
    conditions = []
  }

  stmt_s3_list_screenshots = {
    sid = "ListScreenshotPrefix"
    actions = [
      "s3:ListBucket",
      "s3:ListBucketVersions",
    ]
    resources = [var.screenshot_bucket_arn]
    conditions = [{
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${var.screenshot_prefix}*"]
    }]
  }

  # S3 performs the KMS call on the caller's behalf, so the grant is narrowed
  # with kms:ViaService instead of being left open.
  stmt_kms_encrypt_via_s3 = {
    sid = "EncryptScreenshotsThroughS3"
    actions = [
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyWithoutPlaintext",
      "kms:DescribeKey",
    ]
    resources = [var.s3_kms_key_arn]
    conditions = [{
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${local.region}.amazonaws.com"]
    }]
  }

  stmt_kms_decrypt_via_s3 = {
    sid = "DecryptScreenshotsThroughS3"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
    ]
    resources = [var.s3_kms_key_arn]
    conditions = [{
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${local.region}.amazonaws.com"]
    }]
  }

  # ---- function catalogue ------------------------------------------------
  # Every entry declares the same attributes, in the same types, so the map
  # stays homogeneous and `for_each` over it is unambiguous.
  data_plane_functions = {
    "enroll" = {
      description            = "POST /v1/device/enroll - consumes a single-use enrollment token and derives the device secret (D4)"
      memory_size            = 512
      timeout                = 15
      in_vpc                 = true
      reserved_concurrency   = -1
      ephemeral_storage_size = 512
      environment            = merge(local.db_env, local.device_auth_env)
      policy_statements = [
        local.stmt_db_connect,
        local.stmt_read_root_key,
        local.stmt_decrypt_secrets,
      ]
    }

    "device-config" = {
      description            = "GET /v1/device/config - returns monitoring_config and config_version to the agent"
      memory_size            = 512
      timeout                = 10
      in_vpc                 = true
      reserved_concurrency   = -1
      ephemeral_storage_size = 512
      environment            = local.db_env
      policy_statements      = [local.stmt_db_connect]
    }

    "ingest-events" = {
      description            = "POST /v1/device/events - idempotent batched activity ingest"
      memory_size            = 1024
      timeout                = 30
      in_vpc                 = true
      reserved_concurrency   = var.ingest_reserved_concurrency
      ephemeral_storage_size = 512
      environment = merge(local.db_env, {
        MAX_EVENTS_PER_BATCH = tostring(var.max_events_per_batch)
      })
      policy_statements = [local.stmt_db_connect]
    }

    "screenshot-presign" = {
      description            = "POST /v1/device/screenshots - issues a constrained 15 minute presigned PUT"
      memory_size            = 512
      timeout                = 15
      in_vpc                 = true
      reserved_concurrency   = -1
      ephemeral_storage_size = 512
      environment            = merge(local.db_env, local.bucket_env)
      policy_statements = [
        local.stmt_db_connect,
        local.stmt_s3_put_screenshot,
        local.stmt_kms_encrypt_via_s3,
      ]
    }

    "screenshot-complete" = {
      description            = "POST /v1/device/screenshots/{id}/complete - verifies the object and marks it uploaded"
      memory_size            = 512
      timeout                = 10
      in_vpc                 = true
      reserved_concurrency   = -1
      ephemeral_storage_size = 512
      environment            = merge(local.db_env, local.bucket_env)
      policy_statements = [
        local.stmt_db_connect,
        local.stmt_s3_get_screenshot,
        local.stmt_kms_decrypt_via_s3,
      ]
    }

    "heartbeat" = {
      description            = "POST /v1/device/heartbeat - updates last_seen_at and agent health"
      memory_size            = 512
      timeout                = 10
      in_vpc                 = true
      reserved_concurrency   = -1
      ephemeral_storage_size = 512
      environment            = local.db_env
      policy_statements      = [local.stmt_db_connect]
    }

    "notice-ack" = {
      description            = "POST /v1/device/notice-ack - records first-run notice acknowledgment"
      memory_size            = 512
      timeout                = 10
      in_vpc                 = true
      reserved_concurrency   = -1
      ephemeral_storage_size = 512
      environment            = local.db_env
      policy_statements      = [local.stmt_db_connect]
    }

    "device-authorizer" = {
      description            = "API Gateway REQUEST authorizer - HMAC signature, timestamp window, nonce and revocation checks (D3)"
      memory_size            = 512
      timeout                = 10
      in_vpc                 = true
      reserved_concurrency   = -1
      ephemeral_storage_size = 512
      environment            = merge(local.db_env, local.device_auth_env)
      policy_statements = [
        local.stmt_db_connect,
        local.stmt_read_root_key,
        local.stmt_decrypt_secrets,
      ]
    }

    "reporting-api" = {
      description            = "Dashboard read routes - overview, timesheets, activity, screenshot URLs, CSV export"
      memory_size            = 1024
      timeout                = 30
      in_vpc                 = true
      reserved_concurrency   = -1
      ephemeral_storage_size = 512
      environment            = merge(local.db_env, local.bucket_env)
      policy_statements = [
        local.stmt_db_connect,
        local.stmt_s3_get_screenshot,
        local.stmt_kms_decrypt_via_s3,
      ]
    }

    "admin-api" = {
      description            = "Dashboard write routes - employees, projects, config, devices, users, audit log, erasure"
      memory_size            = 1024
      timeout                = 30
      in_vpc                 = true
      reserved_concurrency   = -1
      ephemeral_storage_size = 512
      environment            = merge(local.db_env, local.bucket_env)
      policy_statements = [
        local.stmt_db_connect,
        local.stmt_s3_get_screenshot,
        local.stmt_s3_delete_screenshot,
        local.stmt_s3_list_screenshots,
        local.stmt_kms_decrypt_via_s3,
      ]
    }

    "aggregate-timesheets" = {
      description            = "Nightly rollup of activity_events into timesheets, and POST /v1/aggregation/run"
      memory_size            = 1024
      timeout                = 300
      in_vpc                 = true
      reserved_concurrency   = -1
      ephemeral_storage_size = 512
      environment            = local.db_env
      policy_statements      = [local.stmt_db_connect]
    }

    "retention-sweeper" = {
      description            = "Daily retention enforcement: events, screenshots, and their S3 objects"
      memory_size            = 1024
      timeout                = 300
      in_vpc                 = true
      reserved_concurrency   = -1
      ephemeral_storage_size = 512
      environment            = merge(local.db_env, local.bucket_env)
      policy_statements = [
        local.stmt_db_connect,
        local.stmt_s3_list_screenshots,
        local.stmt_s3_delete_screenshot,
        local.stmt_kms_decrypt_via_s3,
      ]
    }

    # Runs INSIDE the VPC, which it must: the claims it injects (org, role, employee)
    # come from Postgres, and the database is only reachable from the private subnets.
    # It also calls cognito-idp:AdminGetUser for MFA status, and with no NAT gateway (D6)
    # that reaches Cognito through the cognito-idp interface VPC endpoint — which is why
    # network's enable_cognito_vpc_endpoint defaults to true. Its Cognito permissions are
    # attached by modules/auth, which owns the user pool ARN.
    "pre-token-generation" = {
      description            = "Cognito pre-token-generation trigger - injects org, role, employee and wl:mfa claims (D7)"
      memory_size            = 512
      timeout                = 10
      in_vpc                 = true
      reserved_concurrency   = -1
      ephemeral_storage_size = 512
      environment            = local.db_env
      policy_statements      = [local.stmt_db_connect]
    }

    # Separate from retention-sweeper on purpose. Retention deletes employee data and is
    # an auditable act on an org's configured schedule; this only expires replay-protection
    # bookkeeping and runs hourly so device_nonces stays small. Conflating the two would
    # tie a security control's cadence to a data-policy setting.
    "nonce-sweeper" = {
      description            = "Hourly expiry of device_nonces older than the accepted request timestamp window"
      memory_size            = 256
      timeout                = 60
      in_vpc                 = true
      reserved_concurrency   = -1
      ephemeral_storage_size = 512
      environment            = merge(local.db_env, local.device_auth_env)
      policy_statements      = [local.stmt_db_connect]
    }
  }

  migrate_function = {
    "db-migrate" = {
      description            = "Runs backend/migrations forward-only from inside the VPC; the database is not publicly reachable"
      memory_size            = 1024
      timeout                = 300
      in_vpc                 = true
      reserved_concurrency   = -1
      ephemeral_storage_size = 512
      environment = merge(local.db_env, {
        DB_MASTER_SECRET_ARN = var.db_master_user_secret_arn
        DB_APP_USER          = var.db_user
      })
      policy_statements = [
        local.stmt_read_master_secret,
        local.stmt_decrypt_secrets,
      ]
    }
  }

  functions = merge(
    local.data_plane_functions,
    var.create_db_migrate_function ? local.migrate_function : {},
  )
}

module "function" {
  source = "./modules/function"

  for_each = local.functions

  function_name = "${var.name_prefix}-${each.key}"
  description   = each.value.description
  artifact_path = "${var.artifact_dir}/${each.key}.zip"
  runtime       = var.runtime
  architecture  = var.architecture

  memory_size                    = each.value.memory_size
  timeout                        = each.value.timeout
  ephemeral_storage_size         = each.value.ephemeral_storage_size
  reserved_concurrent_executions = each.value.reserved_concurrency

  environment_variables = merge(local.base_env, each.value.environment)

  subnet_ids         = each.value.in_vpc ? var.subnet_ids : []
  security_group_ids = each.value.in_vpc ? var.security_group_ids : []

  log_retention_days = var.log_retention_days
  log_kms_key_arn    = var.log_kms_key_arn
  log_level          = var.log_level

  policy_statements = each.value.policy_statements

  tags = merge(var.tags, { Function = each.key })
}
