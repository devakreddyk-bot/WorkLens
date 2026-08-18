# ---------------------------------------------------------------------------
# CloudWatch alarms.
#
# These live in their own module rather than alongside the KMS keys and the SNS topic
# because of the dependency direction: an alarm needs the *identifiers* of things that
# are created late (Lambda function names, the RDS instance id), while those same things
# encrypt with CMKs created early. Declaring both in one module would make that module
# depend on the resources that depend on it — a cycle Terraform rejects.
#
# So: modules/observability owns the keys, the trail, the device root key and the topic.
# This module owns everything that watches the finished stack, and is applied last.
# ---------------------------------------------------------------------------

locals {
  # FreeStorageSpace is reported in bytes; the threshold is expressed as a percentage of
  # allocated storage so it stays meaningful after the instance is resized.
  rds_free_storage_threshold_bytes = floor(
    var.rds_allocated_storage_gb * 1024 * 1024 * 1024 * var.rds_free_storage_threshold_pct / 100
  )
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = var.lambda_function_names

  alarm_name          = "${var.name_prefix}-lambda-errors-${each.key}"
  alarm_description   = "Lambda ${each.value} reported errors in the last 5 minutes."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.lambda_error_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = each.value
  }

  alarm_actions = [var.alarm_topic_arn]
  ok_actions    = [var.alarm_topic_arn]

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "ingest_throttles" {
  alarm_name          = "${var.name_prefix}-lambda-throttles-ingest-events"
  alarm_description   = "The ingest function is hitting its reserved concurrency ceiling; agents are being 429'd."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = var.ingest_function_name
  }

  alarm_actions = [var.alarm_topic_arn]
  ok_actions    = [var.alarm_topic_arn]

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "rds_free_storage" {
  alarm_name          = "${var.name_prefix}-rds-free-storage-low"
  alarm_description   = "RDS free storage dropped below ${var.rds_free_storage_threshold_pct}% of allocated storage."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 2
  threshold           = local.rds_free_storage_threshold_bytes
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"

  dimensions = {
    DBInstanceIdentifier = var.rds_instance_id
  }

  alarm_actions = [var.alarm_topic_arn]
  ok_actions    = [var.alarm_topic_arn]

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${var.name_prefix}-rds-cpu-high"
  alarm_description   = "RDS CPU utilisation above ${var.rds_cpu_threshold_pct}% for 10 minutes."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.rds_cpu_threshold_pct
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = var.rds_instance_id
  }

  alarm_actions = [var.alarm_topic_arn]
  ok_actions    = [var.alarm_topic_arn]

  tags = var.tags
}
