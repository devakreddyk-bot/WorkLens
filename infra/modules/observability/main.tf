# ---------------------------------------------------------------------------
# Cross-cutting security and operations plumbing:
#   * three customer-managed KMS CMKs (rds, s3, logs) with rotation enabled
#   * multi-region CloudTrail writing to the dedicated trail bucket
#   * the device root key secret (docs/PLAN.md deviation D4)
#   * SNS topic + CloudWatch alarms on Lambda errors and RDS health
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  region     = data.aws_region.current.name
  root_arn   = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"

  cloudtrail_arn = "arn:${local.partition}:cloudtrail:${local.region}:${local.account_id}:trail/${var.cloudtrail_name}"
}

# ---------------------------------------------------------------------------
# CMK 1: rds. Encrypts RDS storage/snapshots, the RDS-managed master user
# secret, and the device root key secret (both live in Secrets Manager, hence
# the secretsmanager ViaService grant).
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "rds_key" {
  statement {
    sid       = "EnableRootAccountKeyAdministration"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"] # iam-wildcard-ok: a KMS key policy is attached to one key, so "*" resolves to that key alone. There is no narrower form.

    principals {
      type        = "AWS"
      identifiers = [local.root_arn]
    }
  }

  statement {
    sid    = "AllowRdsAndSecretsManagerUseOnBehalfOfAccountPrincipals"
    effect = "Allow"
    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:CreateGrant",
      "kms:DescribeKey",
    ]
    resources = ["*"] # iam-wildcard-ok: key policies resolve "*" to the key they are attached to; further narrowed by the conditions below.

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [local.account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values = [
        "rds.${local.region}.amazonaws.com",
        "secretsmanager.${local.region}.amazonaws.com",
      ]
    }
  }
}

resource "aws_kms_key" "rds" {
  description             = "${var.name_prefix} RDS storage and Secrets Manager encryption"
  deletion_window_in_days = var.kms_deletion_window_days
  enable_key_rotation     = true
  key_usage               = "ENCRYPT_DECRYPT"
  policy                  = data.aws_iam_policy_document.rds_key.json

  tags = merge(var.tags, { Name = "${var.name_prefix}-rds-cmk" })
}

resource "aws_kms_alias" "rds" {
  name          = "alias/${var.name_prefix}-rds"
  target_key_id = aws_kms_key.rds.key_id
}

# ---------------------------------------------------------------------------
# CMK 2: s3. Default encryption for the screenshot bucket; the presign and
# reporting Lambdas hold kms permissions in their own role policies.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "s3_key" {
  statement {
    sid       = "EnableRootAccountKeyAdministration"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"] # iam-wildcard-ok: a KMS key policy is attached to one key, so "*" resolves to that key alone. See the rds key policy above.

    principals {
      type        = "AWS"
      identifiers = [local.root_arn]
    }
  }

  statement {
    sid    = "AllowUseThroughS3ByAccountPrincipals"
    effect = "Allow"
    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
    ]
    resources = ["*"] # iam-wildcard-ok: key policies resolve "*" to the key they are attached to; further narrowed by the conditions below.

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [local.account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${local.region}.amazonaws.com"]
    }
  }

  # Presigned PUT/GET URLs are signed locally by the Lambdas, which need the
  # key directly (not via the S3 service principal) to compute SSE-KMS headers.
  statement {
    sid    = "AllowAccountPrincipalsDirectDataKeyUse"
    effect = "Allow"
    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
    ]
    resources = ["*"] # iam-wildcard-ok: key policies resolve "*" to the key they are attached to.

    principals {
      type        = "AWS"
      identifiers = [local.root_arn]
    }
  }
}

resource "aws_kms_key" "s3" {
  description             = "${var.name_prefix} S3 screenshot object encryption"
  deletion_window_in_days = var.kms_deletion_window_days
  enable_key_rotation     = true
  key_usage               = "ENCRYPT_DECRYPT"
  policy                  = data.aws_iam_policy_document.s3_key.json

  tags = merge(var.tags, { Name = "${var.name_prefix}-s3-cmk" })
}

resource "aws_kms_alias" "s3" {
  name          = "alias/${var.name_prefix}-s3"
  target_key_id = aws_kms_key.s3.key_id
}

# ---------------------------------------------------------------------------
# CMK 3: logs. CloudWatch log groups, the CloudTrail bucket + trail, and the
# alarm SNS topic.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "logs_key" {
  statement {
    sid       = "EnableRootAccountKeyAdministration"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"] # iam-wildcard-ok: a KMS key policy is attached to one key, so "*" resolves to that key alone. See the rds key policy above.

    principals {
      type        = "AWS"
      identifiers = [local.root_arn]
    }
  }

  # CloudWatch Logs encrypts on behalf of whoever writes to the log group.
  statement {
    sid    = "AllowCloudWatchLogs"
    effect = "Allow"
    actions = [
      "kms:Encrypt*",
      "kms:Decrypt*",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
    ]
    resources = ["*"] # iam-wildcard-ok: key policies resolve "*" to the key they are attached to.

    principals {
      type        = "Service"
      identifiers = ["logs.${local.region}.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:*"]
    }
  }

  statement {
    sid    = "AllowCloudTrailToEncryptLogFiles"
    effect = "Allow"
    actions = [
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
    ]
    resources = ["*"] # iam-wildcard-ok: key policies resolve "*" to the key they are attached to.

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.cloudtrail_arn]
    }
  }

  statement {
    sid    = "AllowCloudTrailReadersToDecryptLogFiles"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:ReEncryptFrom",
    ]
    resources = ["*"] # iam-wildcard-ok: key policies resolve "*" to the key they are attached to.

    principals {
      type        = "AWS"
      identifiers = [local.root_arn]
    }

    condition {
      test     = "StringLike"
      variable = "kms:EncryptionContext:aws:cloudtrail:arn"
      values   = ["arn:${local.partition}:cloudtrail:*:${local.account_id}:trail/*"]
    }
  }

  statement {
    sid    = "AllowCloudWatchAlarmsToPublishToEncryptedTopic"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
    ]
    resources = ["*"] # iam-wildcard-ok: key policies resolve "*" to the key they are attached to.

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com", "events.amazonaws.com"]
    }
  }

  statement {
    sid    = "AllowLogDeliveryForWafLogging"
    effect = "Allow"
    actions = [
      "kms:Encrypt*",
      "kms:Decrypt*",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
    ]
    resources = ["*"] # iam-wildcard-ok: key policies resolve "*" to the key they are attached to.

    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_kms_key" "logs" {
  description             = "${var.name_prefix} CloudWatch Logs, CloudTrail and SNS encryption"
  deletion_window_in_days = var.kms_deletion_window_days
  enable_key_rotation     = true
  key_usage               = "ENCRYPT_DECRYPT"
  policy                  = data.aws_iam_policy_document.logs_key.json

  tags = merge(var.tags, { Name = "${var.name_prefix}-logs-cmk" })
}

resource "aws_kms_alias" "logs" {
  name          = "alias/${var.name_prefix}-logs"
  target_key_id = aws_kms_key.logs.key_id
}

# ---------------------------------------------------------------------------
# CloudTrail (multi-region, log file validation on, SSE-KMS).
# ---------------------------------------------------------------------------

resource "aws_cloudtrail" "this" {
  name                          = var.cloudtrail_name
  s3_bucket_name                = var.cloudtrail_bucket_name
  kms_key_id                    = aws_kms_key.logs.arn
  is_multi_region_trail         = true
  is_organization_trail         = false
  include_global_service_events = true
  enable_log_file_validation    = true
  enable_logging                = true

  dynamic "advanced_event_selector" {
    for_each = var.enable_cloudtrail_s3_data_events ? [1] : []

    content {
      name = "screenshot-object-access"

      field_selector {
        field  = "eventCategory"
        equals = ["Data"]
      }

      field_selector {
        field  = "resources.type"
        equals = ["AWS::S3::Object"]
      }

      field_selector {
        field       = "resources.ARN"
        starts_with = ["${var.screenshot_bucket_arn}/"]
      }
    }
  }

  dynamic "advanced_event_selector" {
    for_each = var.enable_cloudtrail_s3_data_events ? [1] : []

    content {
      name = "management-events"

      field_selector {
        field  = "eventCategory"
        equals = ["Management"]
      }
    }
  }

  tags = merge(var.tags, { Name = var.cloudtrail_name })
}

# ---------------------------------------------------------------------------
# Device root key (docs/PLAN.md D4). Device secrets are DERIVED from this key,
# never stored, so a database dump yields no working device credentials.
# ---------------------------------------------------------------------------

resource "random_password" "device_root_key" {
  length  = var.device_root_key_length
  special = false
}

resource "aws_secretsmanager_secret" "device_root_key" {
  name                    = "${var.name_prefix}/device-root-key"
  description             = "HMAC root key from which per-device secrets are derived (docs/PLAN.md D4). Never stored per device."
  kms_key_id              = aws_kms_key.rds.arn
  recovery_window_in_days = var.secret_recovery_window_days

  tags = var.tags
}

resource "aws_secretsmanager_secret_version" "device_root_key" {
  secret_id = aws_secretsmanager_secret.device_root_key.id

  # Contract for backend/src/shared/*: { "current_key_version": <int>,
  # "keys": { "<version>": "<base64 key material>" } }. Rotation adds a new
  # version key and bumps current_key_version; devices carry key_version.
  secret_string = jsonencode({
    current_key_version = 1
    keys = {
      "1" = base64encode(random_password.device_root_key.result)
    }
  })

  lifecycle {
    # Key rotation is an operational action (docs/OPERATIONS.md), not a
    # Terraform one. Without this, `apply` would revert a rotated key.
    ignore_changes = [secret_string]
  }
}

# ---------------------------------------------------------------------------
# Alarms.
# ---------------------------------------------------------------------------

resource "aws_sns_topic" "alarms" {
  name              = "${var.name_prefix}-alarms"
  kms_master_key_id = aws_kms_key.logs.arn

  tags = var.tags
}

data "aws_iam_policy_document" "alarms_topic" {
  statement {
    sid       = "AllowCloudWatchAlarmsToPublish"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alarms.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["sns:Publish", "sns:Subscribe"]
    resources = [aws_sns_topic.alarms.arn]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_sns_topic_policy" "alarms" {
  arn    = aws_sns_topic.alarms.arn
  policy = data.aws_iam_policy_document.alarms_topic.json
}

resource "aws_sns_topic_subscription" "alarm_email" {
  count = var.alarm_email == null ? 0 : 1

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}
