# Inputs are identifiers of already-created resources, which is why this module is
# separate from observability — see the comment at the top of main.tf.

variable "name_prefix" {
  description = "Prefix applied to every alarm name, e.g. worklens-prod."
  type        = string
}

variable "tags" {
  description = "Tags applied to every alarm."
  type        = map(string)
  default     = {}
}

variable "alarm_topic_arn" {
  description = "SNS topic that receives alarm and OK notifications, from modules/observability."
  type        = string
}

variable "lambda_function_names" {
  description = "Map of logical function key => Lambda function name, used to build per-function error alarms."
  type        = map(string)
  default     = {}
}

variable "lambda_error_threshold" {
  description = "Number of Lambda errors in a 5 minute period that trips the per-function alarm."
  type        = number
  default     = 5
}

variable "ingest_function_name" {
  description = "Function name of the ingest handler, alarmed separately for throttles."
  type        = string
}

variable "rds_instance_id" {
  description = "RDS DB instance identifier to alarm on."
  type        = string
}

variable "rds_allocated_storage_gb" {
  description = "Allocated storage of the RDS instance in GiB; the free-storage alarm threshold is derived from it."
  type        = number
}

variable "rds_free_storage_threshold_pct" {
  description = "Percentage of allocated storage below which the RDS free-storage alarm trips."
  type        = number
  default     = 20
}

variable "rds_cpu_threshold_pct" {
  description = "Average CPU utilisation (%) over 10 minutes that trips the RDS CPU alarm."
  type        = number
  default     = 80
}
