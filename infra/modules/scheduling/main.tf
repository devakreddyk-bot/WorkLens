# ---------------------------------------------------------------------------
# Scheduled work.
#
# Three rules, three different reasons for existing:
#
#   aggregate-timesheets  Turns raw events into timesheets. Runs nightly, and
#                         recomputes several days back rather than one, because an
#                         agent that was offline overnight uploads yesterday's
#                         events today and that late data has to land in the right
#                         day's timesheet.
#   retention-sweeper     Deletes employee data past its configured retention.
#                         Daily. This one deletes personal data, so it is
#                         deliberately separate and separately auditable.
#   nonce-sweeper         Expires replay-protection nonces. Hourly, and unrelated
#                         to any org's data policy — conflating it with retention
#                         would tie a security control's cadence to a config field.
#
# EventBridge is used rather than EventBridge Scheduler: these are three fixed
# cron rules with no need for flexible time windows, per-schedule IAM roles, or a
# schedule group, and `aws_cloudwatch_event_rule` keeps the whole thing in one
# resource per schedule.
# ---------------------------------------------------------------------------

locals {
  # The aggregation window is expressed in UTC, as all EventBridge cron
  # expressions are. Day boundaries themselves are computed per employee in the
  # employee's own timezone inside the job — see backend/src/aggregation/rollup.ts.
  # Running at 20:45 UTC is 02:15 IST, comfortably after the end of an Indian
  # working day and before anyone looks at a dashboard the next morning.
  schedules = {
    "aggregate-timesheets" = {
      description         = "Nightly rollup of activity_events into per-employee daily timesheets"
      schedule_expression = var.aggregation_schedule_expression
      function_arn        = var.aggregate_timesheets_function_arn
      function_name       = var.aggregate_timesheets_function_name
      input = jsonencode({
        source        = "schedule"
        lookback_days = var.aggregation_lookback_days
      })
    }

    "retention-sweeper" = {
      description         = "Daily deletion of events, screenshots and S3 objects past their retention window"
      schedule_expression = var.retention_schedule_expression
      function_arn        = var.retention_sweeper_function_arn
      function_name       = var.retention_sweeper_function_name
      input = jsonencode({
        source = "schedule"
        # A ceiling on how much one run may delete, so a misconfigured retention
        # window cannot turn into an unbounded delete that runs for five minutes
        # and then times out halfway through. The next run picks up the remainder.
        max_deletions_per_run = var.retention_max_deletions_per_run
      })
    }

    "nonce-sweeper" = {
      description         = "Hourly expiry of device_nonces older than the accepted request timestamp window"
      schedule_expression = var.nonce_sweep_schedule_expression
      function_arn        = var.nonce_sweeper_function_arn
      function_name       = var.nonce_sweeper_function_name
      input = jsonencode({
        source = "schedule"
      })
    }
  }
}

resource "aws_cloudwatch_event_rule" "schedule" {
  for_each = local.schedules

  name                = "${var.name_prefix}-${each.key}"
  description         = each.value.description
  schedule_expression = each.value.schedule_expression
  state               = var.enabled ? "ENABLED" : "DISABLED"

  tags = merge(var.tags, { Name = "${var.name_prefix}-${each.key}" })
}

resource "aws_cloudwatch_event_target" "schedule" {
  for_each = local.schedules

  rule = aws_cloudwatch_event_rule.schedule[each.key].name
  # A stable target id: a generated one would churn the plan on every change.
  target_id = "${var.name_prefix}-${each.key}"
  arn       = each.value.function_arn
  input     = each.value.input

  # A scheduled invocation that fails is retried, then dropped. Two hours of retries
  # covers a transient RDS failover or a Lambda throttle; beyond that the run is stale
  # and the next schedule is the better recovery path than a very old retry.
  retry_policy {
    maximum_event_age_in_seconds = var.maximum_event_age_in_seconds
    maximum_retry_attempts       = var.maximum_retry_attempts
  }

  dead_letter_config {
    arn = aws_sqs_queue.dead_letter.arn
  }
}

resource "aws_lambda_permission" "allow_eventbridge" {
  for_each = local.schedules

  statement_id  = "AllowExecutionFromEventBridge-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = each.value.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.schedule[each.key].arn
}

# ---------------------------------------------------------------------------
# Dead-letter queue
# ---------------------------------------------------------------------------
# Without this, an invocation that exhausts its retries vanishes silently and a
# night of timesheets is simply missing with nothing to point at. With it, the
# failed event is retained and the alarm below makes it visible.

resource "aws_sqs_queue" "dead_letter" {
  name = "${var.name_prefix}-schedule-dlq"

  message_retention_seconds = var.dlq_retention_seconds
  sqs_managed_sse_enabled   = true

  tags = merge(var.tags, { Name = "${var.name_prefix}-schedule-dlq" })
}

data "aws_iam_policy_document" "dlq" {
  statement {
    sid    = "AllowEventBridgeToSendFailedInvocations"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dead_letter.arn]

    # Scoped to this module's rules only, so the queue cannot be used as a drop box
    # by any other rule in the account.
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [for rule in aws_cloudwatch_event_rule.schedule : rule.arn]
    }
  }

  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions   = ["sqs:*"]
    resources = [aws_sqs_queue.dead_letter.arn]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_sqs_queue_policy" "dead_letter" {
  queue_url = aws_sqs_queue.dead_letter.id
  policy    = data.aws_iam_policy_document.dlq.json
}

resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  count = var.alarm_topic_arn == null ? 0 : 1

  alarm_name        = "${var.name_prefix}-schedule-dlq-not-empty"
  alarm_description = <<-EOT
    A scheduled job failed every retry and its invocation landed in the dead-letter
    queue. Most often this is aggregation: the affected day's timesheets will be
    missing until the job is re-run, either by the next schedule or through
    POST /v1/aggregation/run. See docs/OPERATIONS.md.
  EOT

  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  # An empty queue reports no datapoints rather than zero, which would otherwise hold
  # the alarm in INSUFFICIENT_DATA forever.
  treat_missing_data = "notBreaching"

  dimensions = { QueueName = aws_sqs_queue.dead_letter.name }

  alarm_actions = [var.alarm_topic_arn]
  ok_actions    = [var.alarm_topic_arn]

  tags = var.tags
}
