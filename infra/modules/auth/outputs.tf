output "user_pool_id" {
  description = "Cognito user pool id."
  value       = aws_cognito_user_pool.this.id
}

output "user_pool_arn" {
  description = "Cognito user pool ARN. Consumed by the API Gateway COGNITO_USER_POOLS authorizer."
  value       = aws_cognito_user_pool.this.arn
}

output "user_pool_endpoint" {
  description = "Issuer host of the pool, used for JWT verification."
  value       = aws_cognito_user_pool.this.endpoint
}

output "user_pool_issuer_url" {
  description = "Full OIDC issuer URL (the iss claim of every token)."
  value       = "https://${aws_cognito_user_pool.this.endpoint}"
}

output "client_id" {
  description = "App client id for the dashboard (public client, no secret)."
  value       = aws_cognito_user_pool_client.dashboard.id
}

output "domain" {
  description = "Hosted UI domain prefix."
  value       = aws_cognito_user_pool_domain.this.domain
}

output "hosted_ui_domain" {
  description = "Fully qualified hosted UI domain."
  value       = "${aws_cognito_user_pool_domain.this.domain}.auth.${data.aws_region.current.name}.amazoncognito.com"
}

output "hosted_ui_login_url" {
  description = "Ready-to-use hosted UI authorization URL for the dashboard client."
  value       = "https://${aws_cognito_user_pool_domain.this.domain}.auth.${data.aws_region.current.name}.amazoncognito.com/oauth2/authorize?client_id=${aws_cognito_user_pool_client.dashboard.id}&response_type=code&scope=openid+email+profile&redirect_uri=${urlencode(var.callback_urls[0])}"
}

output "group_names" {
  description = "Names of the RBAC groups."
  value = [
    aws_cognito_user_group.owner.name,
    aws_cognito_user_group.manager.name,
    aws_cognito_user_group.employee.name,
  ]
}
