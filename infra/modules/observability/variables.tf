variable "name_prefix" {
  description = "Prefix applied to the name of every resource in this module (e.g. worklens-prod)."
  type        = string
}

variable "tags" {
  description = "Common tag map applied to every taggable resource."
  type        = map(string)
}

variable "kms_deletion_window_days" {
  description = "Waiting period (days) before a scheduled CMK deletion completes."
  type        = number
  default     = 30

  validation {
    condition     = var.kms_deletion_window_days >= 7 && var.kms_deletion_window_days <= 30
    error_message = "kms_deletion_window_days must be between 7 and 30."
  }
}

variable "cloudtrail_bucket_name" {
  description = "Name of the S3 bucket (created by the storage module) that receives CloudTrail logs."
  type        = string
}

variable "cloudtrail_name" {
  description = "Name of the CloudTrail trail. Must match the trail name used to build the bucket policy."
  type        = string
}

variable "enable_cloudtrail_s3_data_events" {
  description = <<-EOT
    Log S3 object-level (data plane) events for the screenshot bucket in CloudTrail.
    Off by default: data events are billed per event ($0.10 per 100k) and the application
    audit_log table already records every screenshot view.
  EOT
  type        = bool
  default     = false
}

variable "screenshot_bucket_arn" {
  description = "ARN of the screenshot bucket, used to scope CloudTrail S3 data events."
  type        = string
}

variable "device_root_key_length" {
  description = "Character length of the generated device root key before base64 encoding. 32 chars => 256-bit key material."
  type        = number
  default     = 32

  validation {
    condition     = var.device_root_key_length >= 32
    error_message = "device_root_key_length must be at least 32."
  }
}

variable "secret_recovery_window_days" {
  description = "Secrets Manager recovery window (days) after deletion. 0 forces immediate deletion."
  type        = number
  default     = 30
}

variable "alarm_email" {
  description = "Optional email address subscribed to the alarm SNS topic. Leave null to wire subscribers manually."
  type        = string
  default     = null
}
