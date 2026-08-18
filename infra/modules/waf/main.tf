# ---------------------------------------------------------------------------
# WAFv2 WebACL, REGIONAL scope, attached to the API Gateway stage.
#
# Rule order matters: the rate-based rules run first so a flood is dropped
# before it is inspected by the managed rule groups (managed group evaluation
# is what WAF charges per request for).
# ---------------------------------------------------------------------------

resource "aws_wafv2_web_acl" "this" {
  name        = "${var.name_prefix}-api"
  description = "WorkLens API protection: managed rule sets plus per-IP rate limiting"
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  # 1. Per-IP rate limit across the whole API.
  rule {
    name     = "rate-limit-per-ip"
    priority = 1

    action {
      block {
        custom_response {
          response_code = 429
        }
      }
    }

    statement {
      rate_based_statement {
        limit                 = var.rate_limit_per_five_minutes
        aggregate_key_type    = "IP"
        evaluation_window_sec = 300
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-rate-limit-per-ip"
      sampled_requests_enabled   = true
    }
  }

  # 2. Much tighter limit on the single unauthenticated route.
  rule {
    name     = "rate-limit-enroll"
    priority = 2

    action {
      block {
        custom_response {
          response_code = 429
        }
      }
    }

    statement {
      rate_based_statement {
        limit                 = var.enroll_rate_limit_per_five_minutes
        aggregate_key_type    = "IP"
        evaluation_window_sec = 300

        scope_down_statement {
          byte_match_statement {
            positional_constraint = "ENDS_WITH"
            search_string         = "/device/enroll"

            field_to_match {
              uri_path {}
            }

            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-rate-limit-enroll"
      sampled_requests_enabled   = true
    }
  }

  # 3. AWS managed baseline.
  rule {
    name     = "aws-managed-common"
    priority = 10

    override_action {
      dynamic "count" {
        for_each = var.common_rule_set_count_only ? [1] : []
        content {}
      }

      dynamic "none" {
        for_each = var.common_rule_set_count_only ? [] : [1]
        content {}
      }
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"

        dynamic "rule_action_override" {
          for_each = var.common_rule_set_excluded_rules

          content {
            name = rule_action_override.value

            action_to_use {
              count {}
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-aws-managed-common"
      sampled_requests_enabled   = true
    }
  }

  # 4. Known bad inputs (exploit payloads, malformed request lines).
  rule {
    name     = "aws-managed-known-bad-inputs"
    priority = 11

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"

        dynamic "rule_action_override" {
          for_each = var.known_bad_inputs_excluded_rules

          content {
            name = rule_action_override.value

            action_to_use {
              count {}
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-aws-managed-known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name_prefix}-web-acl"
    sampled_requests_enabled   = true
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-api-web-acl" })
}

resource "aws_wafv2_web_acl_association" "api" {
  resource_arn = var.api_stage_arn
  web_acl_arn  = aws_wafv2_web_acl.this.arn
}

# --- Logging ---------------------------------------------------------------
# The log group name must start with "aws-waf-logs-"; WAF refuses any other
# destination name.

resource "aws_cloudwatch_log_group" "waf" {
  count = var.enable_logging ? 1 : 0

  name              = "aws-waf-logs-${var.name_prefix}-api"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.log_kms_key_arn

  tags = var.tags
}

data "aws_iam_policy_document" "log_delivery" {
  count = var.enable_logging ? 1 : 0

  statement {
    sid    = "AWSLogDeliveryWrite"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.waf[0].arn}:*"]

    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:*"]
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

resource "aws_cloudwatch_log_resource_policy" "waf" {
  count = var.enable_logging ? 1 : 0

  policy_name     = "${var.name_prefix}-waf-log-delivery"
  policy_document = data.aws_iam_policy_document.log_delivery[0].json
}

resource "aws_wafv2_web_acl_logging_configuration" "this" {
  count = var.enable_logging ? 1 : 0

  resource_arn            = aws_wafv2_web_acl.this.arn
  log_destination_configs = [aws_cloudwatch_log_group.waf[0].arn]

  # Device credentials must never be written to a log.
  redacted_fields {
    single_header {
      name = "authorization"
    }
  }

  redacted_fields {
    single_header {
      name = "x-wl-signature"
    }
  }

  redacted_fields {
    single_header {
      name = "cookie"
    }
  }

  dynamic "logging_filter" {
    for_each = var.log_only_blocked_and_counted ? [1] : []

    content {
      default_behavior = "DROP"

      filter {
        behavior    = "KEEP"
        requirement = "MEETS_ANY"

        condition {
          action_condition {
            action = "BLOCK"
          }
        }

        condition {
          action_condition {
            action = "COUNT"
          }
        }
      }
    }
  }

  depends_on = [aws_cloudwatch_log_resource_policy.waf]
}
