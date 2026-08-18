# ---------------------------------------------------------------------------
# Root inputs.
#
# Everything here has a working default except `alarm_email` and the dashboard
# origin, so `terraform apply` with an empty tfvars produces a functioning stack.
# Copy terraform.tfvars.example to terraform.tfvars to override.
# ---------------------------------------------------------------------------

variable "aws_region" {
  description = <<-EOT
    Region for every resource. Defaults to ap-south-1 (Mumbai) because India's DPDP Act
    is the target deployment jurisdiction, and keeping employee data in-country is the
    easiest data-localisation position to defend.
  EOT
  type        = string
  default     = "ap-south-1"
}

variable "project" {
  description = "Project name. Used in resource names and in the Project tag."
  type        = string
  default     = "worklens"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.project))
    error_message = "project must be lowercase alphanumeric with hyphens, 2-21 characters, starting with a letter."
  }
}

variable "environment" {
  description = "Deployment environment. Part of every resource name, so prod and staging can coexist in one account."
  type        = string
  default     = "prod"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.environment))
    error_message = "environment must be lowercase alphanumeric with hyphens, 2-16 characters, starting with a letter."
  }
}

variable "extra_tags" {
  description = "Additional tags merged into the default tag set on every resource."
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

variable "vpc_cidr" {
  description = "CIDR for the VPC. /20 gives room for four /22 subnets across two AZs."
  type        = string
  default     = "10.42.0.0/20"

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr))
    error_message = "vpc_cidr must be a valid IPv4 CIDR block."
  }
}

variable "enable_vpc_flow_logs" {
  description = <<-EOT
    Whether to send VPC flow logs to CloudWatch. On by default: this VPC carries employee
    activity data, and being able to answer "did anything talk to the database that
    should not have" after the fact is worth roughly a dollar a month.
  EOT
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

variable "db_instance_class" {
  description = <<-EOT
    RDS instance class. db.t4g.micro is sized for a single company at up to a few hundred
    devices: ingest is a batched write every 60 seconds per device, not a per-request
    workload. Scale the class before reaching for RDS Proxy — see docs/OPERATIONS.md.
  EOT
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "Initial storage in GB. Autoscales to db_max_allocated_storage."
  type        = number
  default     = 20

  validation {
    condition     = var.db_allocated_storage >= 20
    error_message = "RDS requires at least 20 GB for gp3 storage."
  }
}

variable "db_max_allocated_storage" {
  description = "Storage autoscaling ceiling in GB. Zero disables autoscaling."
  type        = number
  default     = 100
}

variable "db_multi_az" {
  description = <<-EOT
    Whether to run a standby in a second AZ. Off by default because it roughly doubles
    the database bill and this workload tolerates a few minutes of write unavailability:
    agents buffer locally and retry, so a failover costs nobody any data. Turn it on if
    the dashboard being reachable during an AZ failure matters to the deployer.
  EOT
  type        = bool
  default     = false
}

variable "db_backup_retention_days" {
  description = "Automated backup retention in days. Non-zero also enables point-in-time recovery."
  type        = number
  default     = 7

  validation {
    condition     = var.db_backup_retention_days >= 1 && var.db_backup_retention_days <= 35
    error_message = "db_backup_retention_days must be between 1 and 35. Zero would disable point-in-time recovery."
  }
}

variable "cognito_deletion_protection" {
  description = <<-EOT
    Guards the Cognito user pool against deletion. Separate from db_deletion_protection on
    purpose: losing the pool means every dashboard account has to be recreated and every
    user re-enrols MFA, which is a different kind of loss from the database and should not
    be turned off as a side effect of tearing down a database.
  EOT
  type        = bool
  default     = true
}

variable "db_deletion_protection" {
  description = <<-EOT
    Guards against `terraform destroy` taking the database with it. Left on by default;
    a deployer tearing down a real deployment must turn this off deliberately, which is
    exactly the friction it exists to provide.
  EOT
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# Storage and retention
# ---------------------------------------------------------------------------

variable "screenshot_retention_days" {
  description = <<-EOT
    S3 lifecycle expiry for screenshot objects. This is the *backstop*: the authoritative
    retention window is monitoring_config.retention_days_screenshots, enforced by the
    retention sweeper. Set this at or above the longest window any org will configure, so
    the lifecycle rule never deletes data the application still considers live.
  EOT
  type        = number
  default     = 90
}

variable "cloudtrail_retention_days" {
  description = "Lifecycle expiry for CloudTrail objects."
  type        = number
  default     = 365
}

variable "log_retention_days" {
  description = <<-EOT
    CloudWatch log retention for Lambda, API Gateway and WAF. Application logs can
    contain window titles, which are personal data, so this is deliberately short — long
    enough to debug an incident, not long enough to become a second copy of the activity
    database.
  EOT
  type        = number
  default     = 30

  validation {
    condition = contains(
      [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653],
      var.log_retention_days
    )
    error_message = "log_retention_days must be a value CloudWatch Logs accepts (1, 3, 5, 7, 14, 30, 60, 90, ...)."
  }
}

# ---------------------------------------------------------------------------
# Dashboard and authentication
# ---------------------------------------------------------------------------

variable "dashboard_origins" {
  description = <<-EOT
    Origins allowed to call the API and to be redirected to after Cognito login, e.g.
    ["https://worklens.example.com"]. http://localhost:3000 is included by default for
    development; remove it in a production tfvars, because a permitted localhost origin
    is a usable target for an attacker who can get a victim to run something locally.
  EOT
  type        = list(string)
  default     = ["http://localhost:3000"]

  validation {
    condition     = length(var.dashboard_origins) > 0
    error_message = "At least one dashboard origin is required, or nothing can log in."
  }

  validation {
    condition     = alltrue([for o in var.dashboard_origins : can(regex("^https?://", o))])
    error_message = "Each origin must be a scheme-qualified URL with no trailing path, e.g. https://worklens.example.com."
  }
}

variable "cognito_domain_prefix" {
  description = <<-EOT
    Prefix for the Cognito hosted-UI domain, which must be unique across all of AWS in
    the region. Null derives one from the name prefix plus the random suffix, which is
    what makes a first apply work without the deployer having to guess an unused name.
  EOT
  type        = string
  default     = null
}

variable "cognito_advanced_security_mode" {
  description = <<-EOT
    OFF, AUDIT, or ENFORCED. AUDIT records risk signals (impossible travel, credential
    stuffing) without blocking anyone; ENFORCED acts on them. Defaults to AUDIT: this
    pool holds accounts that can read every employee's activity, so the signals are
    worth having, while ENFORCED can lock out a legitimate owner travelling.
  EOT
  type        = string
  default     = "AUDIT"

  validation {
    condition     = contains(["OFF", "AUDIT", "ENFORCED"], var.cognito_advanced_security_mode)
    error_message = "cognito_advanced_security_mode must be OFF, AUDIT, or ENFORCED."
  }
}

# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

variable "api_stage_name" {
  description = "API Gateway stage name. Forms the path prefix, so the API base URL is .../v1."
  type        = string
  default     = "v1"
}

variable "api_throttle_rate_limit" {
  description = "Steady-state request rate for the stage, in requests per second, across all callers."
  type        = number
  default     = 200
}

variable "api_throttle_burst_limit" {
  description = "Burst capacity for the stage. Sized above the rate limit so a fleet-wide sync after an outage is absorbed rather than throttled."
  type        = number
  default     = 400
}

variable "api_custom_domain_name" {
  description = "Optional custom domain, e.g. api.worklens.example.com. Null uses the execute-api hostname."
  type        = string
  default     = null
}

variable "api_acm_certificate_arn" {
  description = "Regional ACM certificate ARN for api_custom_domain_name. Required when that is set."
  type        = string
  default     = null

  validation {
    condition     = var.api_custom_domain_name == null || var.api_acm_certificate_arn != null
    error_message = "api_acm_certificate_arn is required when api_custom_domain_name is set."
  }
}

variable "api_data_trace_enabled" {
  description = <<-EOT
    API Gateway full request/response logging. Off, and it must stay off in any real
    deployment: request bodies contain window titles and page titles, so enabling this
    copies personal data into CloudWatch under a different retention policy than the
    database. Useful for a few minutes in a staging environment, never longer.
  EOT
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# WAF
# ---------------------------------------------------------------------------

variable "waf_rate_limit_per_five_minutes" {
  description = <<-EOT
    WAF rate-based limit per source IP over five minutes. Generous, because an entire
    office can share one NAT address: 50 devices heartbeating and uploading from one IP
    is normal traffic, not an attack.
  EOT
  type        = number
  default     = 2000

  validation {
    condition     = var.waf_rate_limit_per_five_minutes >= 100
    error_message = "AWS WAF requires a rate-based limit of at least 100."
  }
}

variable "waf_enroll_rate_limit_per_five_minutes" {
  description = <<-EOT
    Tighter limit for the enrollment path. Enrollment is unauthenticated by HMAC — the
    agent has no secret yet — so its only protections are token single-use and this
    limit. Onboarding a whole office at once is dozens of calls, not hundreds.
  EOT
  type        = number
  default     = 100
}

variable "waf_count_only" {
  description = <<-EOT
    Put the AWS managed rule sets into count-only mode. Useful for a week after go-live
    to see what would have been blocked before it blocks a real agent, then turn off.
  EOT
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Lambda
# ---------------------------------------------------------------------------

variable "lambda_artifact_dir" {
  description = <<-EOT
    Directory holding the deployment zips, relative to infra/. Produced by
    `make backend-build`, which reads backend/functions.json — the same inventory the
    lambda module declares, so what is built and what is deployed cannot drift.
  EOT
  type        = string
  default     = "../backend/artifacts"
}

variable "ingest_reserved_concurrency" {
  description = <<-EOT
    Reserved concurrency for the ingest function. This is a database protection, not a
    cost control: each container holds a Postgres connection, and db.t4g.micro allows
    roughly 85. Capping ingest means a retry storm from the fleet queues at Lambda
    instead of exhausting connections and taking the dashboard down with it. -1 disables
    the reservation.
  EOT
  type        = number
  default     = 20
}

variable "lambda_log_level" {
  description = "LOG_LEVEL passed to every function: debug, info, warn, or error."
  type        = string
  default     = "info"

  validation {
    condition     = contains(["debug", "info", "warn", "error"], var.lambda_log_level)
    error_message = "lambda_log_level must be debug, info, warn, or error."
  }
}

variable "create_db_migrate_function" {
  description = <<-EOT
    Whether to deploy the in-VPC migration function. Keep it: the database has no public
    access, so this is the only way to apply migrations to the deployed stack without
    standing up a bastion.
  EOT
  type        = bool
  default     = true
}

variable "hmac_timestamp_skew_seconds" {
  description = <<-EOT
    Accepted clock skew for HMAC-signed agent requests. Must stay comfortably below the
    nonce sweep retention interval, or a replay becomes possible at the window boundary.
  EOT
  type        = number
  default     = 300

  validation {
    condition     = var.hmac_timestamp_skew_seconds >= 30 && var.hmac_timestamp_skew_seconds <= 900
    error_message = "hmac_timestamp_skew_seconds must be between 30 and 900."
  }
}

# ---------------------------------------------------------------------------
# Scheduling
# ---------------------------------------------------------------------------

variable "enable_schedules" {
  description = <<-EOT
    Whether the background jobs run. Set false for a first apply, before migrations have
    been applied and before any device has enrolled — an aggregation run against an empty
    schema is log noise, not a signal. Turn on once the stack is live.
  EOT
  type        = bool
  default     = true
}

variable "aggregation_schedule_expression" {
  description = "When nightly aggregation runs, as an EventBridge expression in UTC. Default is 02:15 IST."
  type        = string
  default     = "cron(45 20 * * ? *)"
}

variable "aggregation_lookback_days" {
  description = "Days recomputed per scheduled aggregation run, so events uploaded late still land in the right day."
  type        = number
  default     = 3
}

# ---------------------------------------------------------------------------
# Alerting
# ---------------------------------------------------------------------------

variable "alarm_email" {
  description = <<-EOT
    Address subscribed to the alarm topic. Null creates the topic with no subscriber,
    which means alarms fire into the void — set this before treating the deployment as
    production. AWS sends a confirmation email that must be accepted manually.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.alarm_email == null || can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alarm_email))
    error_message = "alarm_email must be a valid email address, or null."
  }
}

variable "enable_cloudtrail_s3_data_events" {
  description = <<-EOT
    Log every object-level read and write on the screenshot bucket to CloudTrail. Off by
    default because data events are billed per event and the application audit log
    already records who viewed which screenshot. Turn it on where an independent,
    application-external record of screenshot access is required.
  EOT
  type        = bool
  default     = false
}
