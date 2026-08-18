output "instance_id" {
  description = "DB instance identifier."
  value       = aws_db_instance.this.identifier
}

output "instance_arn" {
  description = "DB instance ARN."
  value       = aws_db_instance.this.arn
}

output "resource_id" {
  description = "DbiResourceId of the instance. Required to build rds-db:connect IAM ARNs."
  value       = aws_db_instance.this.resource_id
}

output "endpoint" {
  description = "host:port endpoint of the instance."
  value       = aws_db_instance.this.endpoint
}

output "address" {
  description = "Hostname of the instance."
  value       = aws_db_instance.this.address
}

output "port" {
  description = "Port the instance listens on."
  value       = aws_db_instance.this.port
}

output "db_name" {
  description = "Name of the initial database."
  value       = aws_db_instance.this.db_name
}

output "master_username" {
  description = "Master user name."
  value       = aws_db_instance.this.username
}

output "master_user_secret_arn" {
  description = "ARN of the RDS-managed Secrets Manager secret holding the master credentials. Used only by the migration function."
  value       = try(aws_db_instance.this.master_user_secret[0].secret_arn, null)
}

output "app_db_username" {
  description = "Database role the Lambdas authenticate as via IAM auth."
  value       = var.app_db_username
}

output "iam_auth_resource_arn" {
  description = "rds-db:connect resource ARN for the application database role."
  value       = "arn:${data.aws_partition.current.partition}:rds-db:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:dbuser:${aws_db_instance.this.resource_id}/${var.app_db_username}"
}

output "log_group_name" {
  description = "CloudWatch log group receiving exported PostgreSQL logs."
  value       = aws_cloudwatch_log_group.postgresql.name
}

output "parameter_group_name" {
  description = "Name of the parameter group applied to the instance."
  value       = aws_db_parameter_group.this.name
}
