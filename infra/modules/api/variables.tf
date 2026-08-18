variable "name_prefix" {
  description = "Prefix applied to the name of every resource in this module (e.g. worklens-prod)."
  type        = string
}

variable "tags" {
  description = "Common tag map applied to every taggable resource."
  type        = map(string)
}

variable "stage_name" {
  description = <<-EOT
    Stage name, which is also the first path segment of the public URL. "v1" makes the base URL
    https://<api-id>.execute-api.<region>.amazonaws.com/v1 and the routes /v1/device/events etc.,
    matching docs/PLAN.md section 4.
  EOT
  type        = string
  default     = "v1"
}

variable "invoke_arns" {
  description = "Map of logical function key => Lambda invoke ARN, from modules/lambda."
  type        = map(string)
}

variable "function_names" {
  description = "Map of logical function key => Lambda function name, from modules/lambda."
  type        = map(string)
}

variable "cognito_user_pool_arn" {
  description = "ARN of the Cognito user pool backing the dashboard authorizer."
  type        = string
}

variable "log_kms_key_arn" {
  description = "CMK ARN encrypting the access and execution log groups."
  type        = string
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention in days for API access and execution logs."
  type        = number
  default     = 30
}

variable "throttle_rate_limit" {
  description = "Steady-state request rate ceiling for the stage, in requests per second."
  type        = number
  default     = 200
}

variable "throttle_burst_limit" {
  description = "Burst capacity for the stage, in requests."
  type        = number
  default     = 400
}

variable "logging_level" {
  description = "Execution log verbosity: OFF, ERROR or INFO."
  type        = string
  default     = "INFO"

  validation {
    condition     = contains(["OFF", "ERROR", "INFO"], var.logging_level)
    error_message = "logging_level must be OFF, ERROR or INFO."
  }
}

variable "data_trace_enabled" {
  description = <<-EOT
    Log full request/response bodies for every call. Must stay false: bodies contain employee
    activity data, and CloudWatch is not where that belongs.
  EOT
  type        = bool
  default     = false

  validation {
    condition     = var.data_trace_enabled == false
    error_message = "data_trace_enabled must be false; request bodies carry employee activity data."
  }
}

variable "metrics_enabled" {
  description = "Emit per-method CloudWatch metrics for the stage."
  type        = bool
  default     = true
}

variable "cors_allowed_origins" {
  description = "Origins allowed by the CORS preflight responses on dashboard routes."
  type        = list(string)
  validation {
    condition     = length(var.cors_allowed_origins) == 1
    error_message = <<-EOT
      Exactly one origin is supported. The CORS preflight is an API Gateway MOCK
      integration, which can only return a single static Access-Control-Allow-Origin
      header — with several origins configured, every origin but the first would silently
      fail in a browser. Supporting more requires moving the OPTIONS response into a
      Lambda that echoes the request Origin after checking it against an allowlist.
      Failing at plan time is better than shipping a dashboard that only works from one
      of the hostnames it was configured for.
    EOT
  }

}

variable "minimum_compression_size" {
  description = "Compress responses larger than this many bytes. -1 disables compression."
  type        = number
  default     = 1024
}

variable "custom_domain_name" {
  description = <<-EOT
    Optional custom domain (e.g. api.example.com). When set together with acm_certificate_arn,
    a regional domain name with a TLS 1.2 security policy and a base path mapping is created.
    The execute-api endpoint already negotiates TLS 1.2+ only.
  EOT
  type        = string
  default     = null
}

variable "acm_certificate_arn" {
  description = "Regional ACM certificate ARN for custom_domain_name. Must be in the same region as the API."
  type        = string
  default     = null
}

variable "endpoint_type" {
  description = "API endpoint configuration. REGIONAL is required to attach a WAF WebACL directly (docs/PLAN.md D2)."
  type        = string
  default     = "REGIONAL"

  validation {
    condition     = contains(["REGIONAL", "EDGE", "PRIVATE"], var.endpoint_type)
    error_message = "endpoint_type must be REGIONAL, EDGE or PRIVATE."
  }
}

variable "manage_account_cloudwatch_role" {
  description = <<-EOT
    Create the account-level API Gateway CloudWatch Logs role and set it in the region's API
    Gateway account settings. Required for access and execution logging to work at all, but it
    is a per-account, per-region setting: set false if another stack already manages it.
  EOT
  type        = bool
  default     = true
}
