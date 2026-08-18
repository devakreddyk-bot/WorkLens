variable "name_prefix" {
  description = "Prefix applied to the name of every resource in this module (e.g. worklens-prod)."
  type        = string
}

variable "tags" {
  description = "Common tag map applied to every taggable resource."
  type        = map(string)
}

variable "subnet_ids" {
  description = "Private subnet ids for the DB subnet group. Must span at least two AZs."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) >= 2
    error_message = "RDS requires a subnet group spanning at least two availability zones."
  }
}

variable "vpc_security_group_ids" {
  description = "Security groups attached to the instance. Should be the rds_sg only."
  type        = list(string)
}

variable "kms_key_arn" {
  description = "CMK ARN used for storage encryption, automated backups and the managed master user secret."
  type        = string
}

variable "logs_kms_key_arn" {
  description = "CMK ARN used to encrypt the pre-created PostgreSQL CloudWatch log group."
  type        = string
}

variable "engine_version" {
  description = "PostgreSQL engine version. A bare major version tracks the latest supported minor."
  type        = string
  default     = "16"
}

variable "parameter_group_family" {
  description = "RDS parameter group family. Must match the major engine version."
  type        = string
  default     = "postgres16"
}

variable "instance_class" {
  description = "RDS instance class. db.t4g.micro is the Graviton burstable class costed in docs/PLAN.md section 10."
  type        = string
  default     = "db.t4g.micro"
}

variable "allocated_storage" {
  description = "Initial storage in GiB."
  type        = number
  default     = 20
}

variable "max_allocated_storage" {
  description = "Upper bound for storage autoscaling in GiB. Set equal to allocated_storage to disable autoscaling."
  type        = number
  default     = 100
}

variable "storage_type" {
  description = "EBS volume type backing the instance."
  type        = string
  default     = "gp3"
}

variable "db_name" {
  description = "Name of the initial database created on the instance."
  type        = string
  default     = "worklens"
}

variable "master_username" {
  description = "Master user name. Its password is generated and rotated by RDS in Secrets Manager, never handled by Terraform."
  type        = string
  default     = "wl_admin"
}

variable "app_db_username" {
  description = <<-EOT
    Database role the Lambdas authenticate as with IAM auth. Created by migration 0001
    (GRANT rds_iam), not by Terraform, because Terraform holds no database connection.
  EOT
  type        = string
  default     = "worklens_app"
}

variable "database_port" {
  description = "TCP port the instance listens on."
  type        = number
  default     = 5432
}

variable "backup_retention_period" {
  description = "Days of automated backups to retain."
  type        = number
  default     = 7

  validation {
    condition     = var.backup_retention_period >= 7
    error_message = "docs/PLAN.md section 6 requires at least 7 days of automated backups."
  }
}

variable "backup_window" {
  description = "Daily UTC window for automated backups (hh:mm-hh:mm)."
  type        = string
  default     = "18:00-19:00"
}

variable "maintenance_window" {
  description = "Weekly UTC maintenance window (ddd:hh:mm-ddd:hh:mm)."
  type        = string
  default     = "sun:19:30-sun:20:30"
}

variable "multi_az" {
  description = "Run a standby in a second AZ. Off by default; roughly doubles the instance cost."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Refuse to delete the instance. Required on by docs/PLAN.md section 6."
  type        = bool
  default     = true
}

variable "apply_immediately" {
  description = "Apply modifications immediately instead of during the maintenance window."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for exported PostgreSQL logs."
  type        = number
  default     = 30
}

variable "log_min_duration_statement_ms" {
  description = "Log statements slower than this many milliseconds. -1 disables."
  type        = number
  default     = 1000
}

variable "performance_insights_enabled" {
  description = "Performance Insights. Off by cost decision in docs/PLAN.md section 10."
  type        = bool
  default     = false
}

variable "auto_minor_version_upgrade" {
  description = "Allow RDS to apply minor engine upgrades during the maintenance window."
  type        = bool
  default     = true
}
