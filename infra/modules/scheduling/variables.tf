variable "name_prefix" {
  description = "Prefix applied to every resource name, e.g. worklens-prod."
  type        = string
}

variable "tags" {
  description = "Tags applied to every taggable resource in this module."
  type        = map(string)
  default     = {}
}

variable "enabled" {
  description = <<-EOT
    Whether the schedules are ENABLED. Set false to stand the stack up without any
    background job firing — useful on a first apply, before migrations have run and
    before any device has enrolled, because an aggregation run against an empty
    schema is noise in the logs rather than a signal.
  EOT
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# Target functions
# ---------------------------------------------------------------------------

variable "aggregate_timesheets_function_arn" {
  description = "ARN of the aggregation Lambda."
  type        = string
}

variable "aggregate_timesheets_function_name" {
  description = "Name of the aggregation Lambda, for the invoke permission."
  type        = string
}

variable "retention_sweeper_function_arn" {
  description = "ARN of the retention sweeper Lambda."
  type        = string
}

variable "retention_sweeper_function_name" {
  description = "Name of the retention sweeper Lambda, for the invoke permission."
  type        = string
}

variable "nonce_sweeper_function_arn" {
  description = "ARN of the replay-nonce sweeper Lambda."
  type        = string
}

variable "nonce_sweeper_function_name" {
  description = "Name of the replay-nonce sweeper Lambda, for the invoke permission."
  type        = string
}

# ---------------------------------------------------------------------------
# Cron expressions
# ---------------------------------------------------------------------------

variable "aggregation_schedule_expression" {
  description = <<-EOT
    When the nightly aggregation runs. EventBridge cron is always UTC. The default of
    20:45 UTC is 02:15 IST — after the end of an Indian working day and before anyone
    opens a dashboard the next morning. Change this if the deployment's workforce is
    in a different timezone; per-employee day boundaries are handled inside the job
    regardless, so this only decides when the work happens, not how days are cut.
  EOT
  type        = string
  default     = "cron(45 20 * * ? *)"

  validation {
    condition     = can(regex("^(cron|rate)\\(.+\\)$", var.aggregation_schedule_expression))
    error_message = "Must be an EventBridge schedule expression, e.g. cron(45 20 * * ? *) or rate(1 day)."
  }
}

variable "retention_schedule_expression" {
  description = <<-EOT
    When retention enforcement runs. Deliberately offset from aggregation so the two
    are never deleting and reading the same rows at the same time: aggregation should
    have finished turning yesterday's events into timesheets before retention is
    allowed to delete anything.
  EOT
  type        = string
  default     = "cron(0 22 * * ? *)"

  validation {
    condition     = can(regex("^(cron|rate)\\(.+\\)$", var.retention_schedule_expression))
    error_message = "Must be an EventBridge schedule expression, e.g. cron(0 22 * * ? *) or rate(1 day)."
  }
}

variable "nonce_sweep_schedule_expression" {
  description = <<-EOT
    How often replay-protection nonces are expired. Hourly keeps device_nonces small.
    The retention interval used by the sweeper itself must stay comfortably larger
    than the accepted request timestamp window, or a replay becomes possible at the
    window boundary — see backend/migrations/0002_org_bootstrap.sql.
  EOT
  type        = string
  default     = "rate(1 hour)"

  validation {
    condition     = can(regex("^(cron|rate)\\(.+\\)$", var.nonce_sweep_schedule_expression))
    error_message = "Must be an EventBridge schedule expression, e.g. rate(1 hour)."
  }
}

# ---------------------------------------------------------------------------
# Job inputs
# ---------------------------------------------------------------------------

variable "aggregation_lookback_days" {
  description = <<-EOT
    How many days back a scheduled aggregation run recomputes. More than one on
    purpose: an agent that was offline overnight uploads yesterday's events today,
    and that late data has to be folded into the correct day's timesheet. Aggregation
    is an idempotent upsert, so recomputing a settled day is free.
  EOT
  type        = number
  default     = 3

  validation {
    condition     = var.aggregation_lookback_days >= 1 && var.aggregation_lookback_days <= 31
    error_message = "aggregation_lookback_days must be between 1 and 31."
  }
}

variable "retention_max_deletions_per_run" {
  description = <<-EOT
    Ceiling on rows deleted in one retention run. Bounds a first run against a long
    backlog, or a run after someone shortens the retention window sharply, so it
    cannot become an unbounded delete that times out halfway through. The next
    scheduled run continues where this one stopped.
  EOT
  type        = number
  default     = 200000

  validation {
    condition     = var.retention_max_deletions_per_run >= 1000
    error_message = "retention_max_deletions_per_run must be at least 1000, or retention can never catch up."
  }
}

# ---------------------------------------------------------------------------
# Failure handling
# ---------------------------------------------------------------------------

variable "maximum_event_age_in_seconds" {
  description = "How long EventBridge keeps retrying a failed invocation before dead-lettering it."
  type        = number
  default     = 7200

  validation {
    condition     = var.maximum_event_age_in_seconds >= 60 && var.maximum_event_age_in_seconds <= 86400
    error_message = "maximum_event_age_in_seconds must be between 60 and 86400."
  }
}

variable "maximum_retry_attempts" {
  description = "Retry attempts before an invocation is dead-lettered."
  type        = number
  default     = 3

  validation {
    condition     = var.maximum_retry_attempts >= 0 && var.maximum_retry_attempts <= 185
    error_message = "maximum_retry_attempts must be between 0 and 185."
  }
}

variable "dlq_retention_seconds" {
  description = "How long a dead-lettered invocation is retained for inspection. 14 days is the SQS maximum."
  type        = number
  default     = 1209600

  validation {
    condition     = var.dlq_retention_seconds >= 60 && var.dlq_retention_seconds <= 1209600
    error_message = "dlq_retention_seconds must be between 60 and 1209600 (14 days)."
  }
}

variable "alarm_topic_arn" {
  description = "SNS topic notified when a scheduled job dead-letters. Null disables the alarm."
  type        = string
  default     = null
}
