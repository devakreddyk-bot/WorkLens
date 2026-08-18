output "web_acl_arn" {
  description = "ARN of the regional WebACL."
  value       = aws_wafv2_web_acl.this.arn
}

output "web_acl_id" {
  description = "Id of the regional WebACL."
  value       = aws_wafv2_web_acl.this.id
}

output "web_acl_name" {
  description = "Name of the regional WebACL."
  value       = aws_wafv2_web_acl.this.name
}

output "web_acl_capacity" {
  description = "WCUs consumed by the WebACL. WAF bills per 500 WCUs above the base allocation."
  value       = aws_wafv2_web_acl.this.capacity
}

output "log_group_name" {
  description = "CloudWatch log group receiving WAF logs, or null when logging is disabled."
  value       = try(aws_cloudwatch_log_group.waf[0].name, null)
}
