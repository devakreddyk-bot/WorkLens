variable "name_prefix" {
  description = "Prefix applied to the name of every resource in this module (e.g. worklens-prod)."
  type        = string
}

variable "tags" {
  description = "Common tag map applied to every taggable resource."
  type        = map(string)
}

variable "vpc_cidr" {
  description = "IPv4 CIDR block for the VPC. Must be large enough for 2 public + 2 private /24 subnets."
  type        = string
  default     = "10.30.0.0/16"
}

variable "availability_zone_count" {
  description = "Number of availability zones to spread subnets across. The plan requires 2."
  type        = number
  default     = 2

  validation {
    condition     = var.availability_zone_count >= 2 && var.availability_zone_count <= 3
    error_message = "availability_zone_count must be 2 or 3."
  }
}

variable "interface_endpoint_subnet_count" {
  description = <<-EOT
    How many private subnets receive an ENI for each interface VPC endpoint.
    Each ENI costs ~$7.30/month. 1 matches the cost model in docs/PLAN.md section 10;
    2 removes the single-AZ dependency at roughly double the endpoint cost.
  EOT
  type        = number
  default     = 1

  validation {
    condition     = var.interface_endpoint_subnet_count >= 1
    error_message = "interface_endpoint_subnet_count must be at least 1."
  }
}

variable "enable_cognito_vpc_endpoint" {
  description = <<-EOT
    Create a cognito-idp interface endpoint. Required for the in-VPC admin-api Lambda to
    manage dashboard users (POST/PATCH /v1/users) because there is no NAT gateway (D6).
    Disable only if dashboard users are created out-of-band with the AWS console/CLI.
  EOT
  type        = bool
  default     = true
}

variable "flow_log_retention_days" {
  description = "CloudWatch Logs retention (days) for VPC flow logs."
  type        = number
  default     = 30
}

variable "logs_kms_key_arn" {
  description = "KMS CMK ARN used to encrypt the VPC flow log group."
  type        = string
}

variable "enable_flow_logs" {
  description = "Emit VPC flow logs (REJECT + ACCEPT) to a KMS-encrypted CloudWatch log group."
  type        = bool
  default     = true
}

variable "database_port" {
  description = "TCP port the database listens on; used to scope the Lambda->RDS security group rules."
  type        = number
  default     = 5432
}
