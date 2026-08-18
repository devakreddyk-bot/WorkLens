output "function_name" {
  description = "Name of the function."
  value       = aws_lambda_function.this.function_name
}

output "arn" {
  description = "ARN of the function."
  value       = aws_lambda_function.this.arn
}

output "qualified_arn" {
  description = "Version-qualified ARN of the function."
  value       = aws_lambda_function.this.qualified_arn
}

output "invoke_arn" {
  description = "ARN used by API Gateway AWS_PROXY integrations."
  value       = aws_lambda_function.this.invoke_arn
}

output "role_name" {
  description = "Name of the function's execution role."
  value       = aws_iam_role.this.name
}

output "role_arn" {
  description = "ARN of the function's execution role."
  value       = aws_iam_role.this.arn
}

output "log_group_name" {
  description = "Name of the function's log group."
  value       = aws_cloudwatch_log_group.this.name
}

output "log_group_arn" {
  description = "ARN of the function's log group."
  value       = aws_cloudwatch_log_group.this.arn
}
