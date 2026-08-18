variable "function_name" {
  description = "Full Lambda function name."
  type        = string
}

variable "description" {
  description = "What this function does. Shows up in the console; keep it useful."
  type        = string
}

variable "tags" {
  description = "Common tag map applied to every taggable resource."
  type        = map(string)
}

variable "artifact_path" {
  description = <<-EOT
    Path to the deployment zip. The backend build produces it; Terraform only references it.
    filename is used rather than an archive_file data source precisely so that
    `terraform validate` does not require the artifact to exist yet.
  EOT
  type        = string
}

variable "handler" {
  description = "Module and exported function to invoke."
  type        = string
  default     = "index.handler"
}

variable "runtime" {
  description = "Lambda runtime identifier."
  type        = string
  default     = "nodejs22.x"
}

variable "architecture" {
  description = "Instruction set architecture. arm64 (Graviton) is ~20% cheaper per GB-second."
  type        = string
  default     = "arm64"

  validation {
    condition     = contains(["arm64", "x86_64"], var.architecture)
    error_message = "architecture must be arm64 or x86_64."
  }
}

variable "memory_size" {
  description = "Memory in MB, which also determines CPU share."
  type        = number
  default     = 512
}

variable "timeout" {
  description = "Maximum execution time in seconds."
  type        = number
  default     = 15
}

variable "ephemeral_storage_size" {
  description = "Size of /tmp in MB."
  type        = number
  default     = 512
}

variable "environment_variables" {
  description = "Environment variables for the function. Never put secret values here, only ARNs and names."
  type        = map(string)
  default     = {}
}

variable "reserved_concurrent_executions" {
  description = "Reserved concurrency. -1 leaves the function on the unreserved account pool."
  type        = number
  default     = -1
}

variable "subnet_ids" {
  description = "Private subnet ids. Empty list means the function runs outside the VPC."
  type        = list(string)
  default     = []
}

variable "security_group_ids" {
  description = "Security groups for the function's ENIs. Required when subnet_ids is non-empty."
  type        = list(string)
  default     = []
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention in days for this function's log group."
  type        = number
  default     = 30
}

variable "log_kms_key_arn" {
  description = "CMK ARN encrypting this function's log group."
  type        = string
}

variable "log_level" {
  description = "Minimum application log level captured by the Lambda logging configuration."
  type        = string
  default     = "INFO"
}

variable "policy_statements" {
  description = <<-EOT
    Extra least-privilege IAM statements for this function's role. Every statement must name
    concrete resource ARNs. The only resource wildcards in this module are the EC2 Describe
    actions that AWS does not support resource-level permissions for.
  EOT
  type = list(object({
    sid       = string
    actions   = list(string)
    resources = list(string)
    conditions = optional(list(object({
      test     = string
      variable = string
      values   = list(string)
    })), [])
  }))
  default = []
}

variable "layers" {
  description = "Lambda layer ARNs to attach."
  type        = list(string)
  default     = []
}
