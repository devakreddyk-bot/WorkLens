variable "name_prefix" {
  description = "Prefix applied to the name of every resource in this module (e.g. worklens-prod). Function names are <name_prefix>-<key>."
  type        = string
}

variable "tags" {
  description = "Common tag map applied to every taggable resource."
  type        = map(string)
}

variable "environment" {
  description = "Deployment environment name, exposed to handlers as ENVIRONMENT."
  type        = string
}

variable "artifact_dir" {
  description = <<-EOT
    Directory holding one zip per function, named <function key>.zip. Produced by the backend
    build (`npm run build` in backend/, esbuild bundle per handler). Terraform references the
    files with `filename`, so `terraform validate` succeeds before they exist, but `apply` needs them.
  EOT
  type        = string
}

variable "runtime" {
  description = "Lambda runtime for every function."
  type        = string
  default     = "nodejs22.x"
}

variable "architecture" {
  description = "Instruction set architecture for every function."
  type        = string
  default     = "arm64"
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention in days for every function log group."
  type        = number
  default     = 30
}

variable "log_kms_key_arn" {
  description = "CMK ARN encrypting every function log group."
  type        = string
}

variable "log_level" {
  description = "Application log level for every function."
  type        = string
  default     = "INFO"
}

variable "subnet_ids" {
  description = "Private subnet ids for the data-plane functions."
  type        = list(string)
}

variable "security_group_ids" {
  description = "Security groups for the data-plane functions (the lambda_sg)."
  type        = list(string)
}

variable "db_host" {
  description = "RDS hostname."
  type        = string
}

variable "db_port" {
  description = "RDS port."
  type        = number
}

variable "db_name" {
  description = "Database name."
  type        = string
}

variable "db_user" {
  description = "Database role the functions authenticate as via RDS IAM auth."
  type        = string
}

variable "db_iam_auth_resource_arn" {
  description = "rds-db:connect resource ARN for db_user on this instance."
  type        = string
}

variable "db_master_user_secret_arn" {
  description = "ARN of the RDS-managed master credential secret. Only the migration function may read it."
  type        = string
}

variable "device_root_key_secret_arn" {
  description = "ARN of the device root key secret (docs/PLAN.md D4)."
  type        = string
}

variable "rds_kms_key_arn" {
  description = "CMK ARN protecting Secrets Manager secrets; readers need kms:Decrypt on it."
  type        = string
}

variable "screenshot_bucket_name" {
  description = "Screenshot bucket name."
  type        = string
}

variable "screenshot_bucket_arn" {
  description = "Screenshot bucket ARN."
  type        = string
}

variable "screenshot_prefix" {
  description = "Key prefix all screenshot objects live under. IAM statements are scoped to it."
  type        = string
  default     = "screenshots/"
}

variable "s3_kms_key_arn" {
  description = "CMK ARN for screenshot objects. Presigned PUTs must carry it in the SSE-KMS header."
  type        = string
}

variable "ingest_reserved_concurrency" {
  description = <<-EOT
    Reserved concurrency for ingest-events. This is the database protection valve
    (docs/PLAN.md D6): each container holds one connection, so this caps DB connections
    from ingest. Agents receive 429 and retry with backoff beyond it.
  EOT
  type        = number
  default     = 20
}

variable "hmac_timestamp_skew_seconds" {
  description = "Accepted clock skew for X-WL-Timestamp (docs/PLAN.md D3)."
  type        = number
  default     = 300
}

variable "nonce_retention_seconds" {
  description = "How long device nonces are remembered for replay rejection."
  type        = number
  default     = 600
}

variable "max_events_per_batch" {
  description = "Maximum events accepted in a single ingest batch."
  type        = number
  default     = 500
}

variable "presign_expiry_seconds" {
  description = "Lifetime of presigned screenshot upload/download URLs."
  type        = number
  default     = 900
}

variable "create_db_migrate_function" {
  description = <<-EOT
    Create the db-migrate function. RDS is not publicly reachable and there is no NAT gateway,
    so schema migrations must run from inside the VPC; this function is how `make migrate`
    reaches the database. Requires <artifact_dir>/db-migrate.zip.
  EOT
  type        = bool
  default     = true
}
