variable "aws_region" {
  description = "Region for the state bucket and lock table. Must match the region in the root module's backend block."
  type        = string
  default     = "ap-south-1"
}

variable "project" {
  description = "Project name, used to build the bucket and table names."
  type        = string
  default     = "worklens"
}

variable "state_bucket_name" {
  description = <<-EOT
    Name for the state bucket. S3 names are global, so null appends a random suffix to
    keep a first run from colliding with any other WorkLens deployment on earth.
  EOT
  type        = string
  default     = null
}

variable "lock_table_name" {
  description = "DynamoDB table holding state locks."
  type        = string
  default     = null
}

variable "noncurrent_version_retention_days" {
  description = <<-EOT
    How long superseded state versions are kept. This is the recovery window for a
    corrupted or truncated state file, which is the whole reason versioning is on, so it
    is deliberately generous — 90 days of state history costs cents.
  EOT
  type        = number
  default     = 90

  validation {
    condition     = var.noncurrent_version_retention_days >= 7
    error_message = "Keep at least 7 days of state history, or the versioning provides no realistic recovery window."
  }
}
