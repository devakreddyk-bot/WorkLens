output "rest_api_id" {
  description = "REST API id."
  value       = aws_api_gateway_rest_api.this.id
}

output "rest_api_arn" {
  description = "REST API ARN."
  value       = aws_api_gateway_rest_api.this.arn
}

output "execution_arn" {
  description = "Execution ARN used in Lambda permission source ARNs."
  value       = aws_api_gateway_rest_api.this.execution_arn
}

output "stage_name" {
  description = "Deployed stage name, which is also the first path segment."
  value       = aws_api_gateway_stage.this.stage_name
}

output "stage_arn" {
  description = "Stage ARN. Consumed by the WAF WebACL association."
  value       = aws_api_gateway_stage.this.arn
}

output "invoke_url" {
  description = "Base URL of the stage, e.g. https://<api-id>.execute-api.<region>.amazonaws.com/v1."
  value       = aws_api_gateway_stage.this.invoke_url
}

output "api_base_url" {
  description = "Base URL agents and the dashboard should use (the custom domain when configured)."
  value       = local.create_custom_domain ? "https://${var.custom_domain_name}/${var.stage_name}" : aws_api_gateway_stage.this.invoke_url
}

output "custom_domain_regional_domain_name" {
  description = "Regional target for the DNS CNAME/ALIAS record, or null when no custom domain is configured."
  value       = try(aws_api_gateway_domain_name.this[0].regional_domain_name, null)
}

output "custom_domain_regional_zone_id" {
  description = "Hosted zone id of the regional endpoint, or null when no custom domain is configured."
  value       = try(aws_api_gateway_domain_name.this[0].regional_zone_id, null)
}

output "access_log_group_name" {
  description = "CloudWatch log group receiving stage access logs."
  value       = aws_cloudwatch_log_group.access.name
}

output "execution_log_group_name" {
  description = "CloudWatch log group receiving execution logs."
  value       = aws_cloudwatch_log_group.execution.name
}

output "dashboard_authorizer_id" {
  description = "Id of the Cognito user pool authorizer."
  value       = aws_api_gateway_authorizer.dashboard.id
}

output "routes" {
  description = "Every wired route, as \"<METHOD> <path>\" => integrated function key."
  value       = { for key, route in local.routes : key => route.function }
}
