variable "name_prefix" {
  description = "Prefix applied to the name of every resource in this module (e.g. worklens-prod)."
  type        = string
}

variable "tags" {
  description = "Common tag map applied to every taggable resource."
  type        = map(string)
}

variable "api_stage_arn" {
  description = "ARN of the API Gateway REST API stage the WebACL is associated with."
  type        = string
}

variable "rate_limit_per_five_minutes" {
  description = "Requests from a single IP in any 5 minute window before that IP is blocked."
  type        = number
  default     = 2000

  validation {
    condition     = var.rate_limit_per_five_minutes >= 100
    error_message = "AWS WAF requires a rate-based limit of at least 100."
  }
}

variable "enroll_rate_limit_per_five_minutes" {
  description = <<-EOT
    Tighter rate limit applied only to /v1/device/enroll. Enrollment is the one unauthenticated
    route, so it gets its own much lower ceiling on top of single-use tokens.
  EOT
  type        = number
  default     = 100
}

variable "common_rule_set_count_only" {
  description = <<-EOT
    Run AWSManagedRulesCommonRuleSet in count mode instead of block. Useful for a first
    deployment while confirming no legitimate agent traffic is caught; flip back to false.
  EOT
  type        = bool
  default     = false
}

variable "common_rule_set_excluded_rules" {
  description = <<-EOT
    Rules inside AWSManagedRulesCommonRuleSet to run in count mode. SizeRestrictions_BODY is
    excluded by default because an ingest batch of 500 events legitimately exceeds the 8 KB
    body size the managed rule flags.
  EOT
  type        = list(string)
  default     = ["SizeRestrictions_BODY"]
}

variable "known_bad_inputs_excluded_rules" {
  description = "Rules inside AWSManagedRulesKnownBadInputsRuleSet to run in count mode."
  type        = list(string)
  default     = []
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention in days for WAF logs."
  type        = number
  default     = 30
}

variable "log_kms_key_arn" {
  description = "CMK ARN encrypting the WAF log group."
  type        = string
}

variable "enable_logging" {
  description = "Send WebACL request logs to CloudWatch Logs."
  type        = bool
  default     = true
}

variable "log_only_blocked_and_counted" {
  description = <<-EOT
    Log only requests WAF blocked or counted, not every allowed request. Keeps CloudWatch cost
    proportional to attack traffic rather than to normal agent traffic.
  EOT
  type        = bool
  default     = true
}
