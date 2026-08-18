variable "name_prefix" {
  description = "Prefix applied to the name of every resource in this module (e.g. worklens-prod)."
  type        = string
}

variable "tags" {
  description = "Common tag map applied to every taggable resource."
  type        = map(string)
}

variable "screenshot_bucket_name" {
  description = "Globally unique name for the screenshot bucket. Computed in the root module from a random suffix."
  type        = string
}

variable "cloudtrail_bucket_name" {
  description = "Globally unique name for the CloudTrail log bucket. Computed in the root module from a random suffix."
  type        = string
}

variable "s3_kms_key_arn" {
  description = "CMK ARN used for default SSE-KMS encryption of screenshot objects."
  type        = string
}

variable "s3_kms_key_id" {
  description = "Key id of the screenshot CMK, used in the bucket policy that pins the allowed SSE key."
  type        = string
}

variable "logs_kms_key_arn" {
  description = "CMK ARN used for default SSE-KMS encryption of the CloudTrail bucket."
  type        = string
}

variable "cloudtrail_arn" {
  description = <<-EOT
    ARN of the CloudTrail trail allowed to write to the CloudTrail bucket. Passed as a
    deterministic string (built in the root module) rather than read from the observability
    module output, so the two modules do not form a dependency cycle.
  EOT
  type        = string
}

variable "screenshot_retention_days" {
  description = <<-EOT
    Lifecycle expiration for screenshot objects. Second line of defence behind the
    retention-sweeper Lambda; keep it >= monitoring_config.retention_days_screenshots.
  EOT
  type        = number
  default     = 30

  validation {
    condition     = var.screenshot_retention_days >= 1
    error_message = "screenshot_retention_days must be at least 1."
  }
}

variable "screenshot_noncurrent_version_days" {
  description = "Days a non-current screenshot object version is kept before permanent deletion."
  type        = number
  default     = 7
}

variable "cloudtrail_retention_days" {
  description = "Lifecycle expiration for CloudTrail log objects."
  type        = number
  default     = 365
}

variable "cloudtrail_transition_days" {
  description = "Days before CloudTrail log objects transition to STANDARD_IA."
  type        = number
  default     = 90
}

variable "dashboard_origins" {
  description = "Origins allowed to send cross-origin PUT/GET to the screenshot bucket (the dashboard host)."
  type        = list(string)
}

variable "agent_upload_origins" {
  description = <<-EOT
    Extra origins allowed by CORS for direct agent PUTs. The Windows agent is not a browser and
    sends no Origin header, so this normally stays empty; it exists for browser-based test tools.
  EOT
  type        = list(string)
  default     = []
}
