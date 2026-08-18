output "vpc_id" {
  description = "VPC id."
  value       = aws_vpc.this.id
}

output "vpc_cidr" {
  description = "VPC IPv4 CIDR block."
  value       = aws_vpc.this.cidr_block
}

output "private_subnet_ids" {
  description = "Private subnet ids (no default route). Lambda and RDS live here."
  value       = aws_subnet.private[*].id
}

output "public_subnet_ids" {
  description = "Public subnet ids (IGW route). Unused by default; reserved for a future bastion."
  value       = aws_subnet.public[*].id
}

output "availability_zones" {
  description = "Availability zones the subnets are spread across."
  value       = local.azs
}

output "lambda_security_group_id" {
  description = "Security group for in-VPC Lambda functions."
  value       = aws_security_group.lambda.id
}

output "rds_security_group_id" {
  description = "Security group for the RDS instance."
  value       = aws_security_group.rds.id
}

output "vpc_endpoint_security_group_id" {
  description = "Security group attached to the interface VPC endpoints."
  value       = aws_security_group.vpc_endpoints.id
}

output "s3_prefix_list_id" {
  description = "Prefix list id of the S3 gateway endpoint."
  value       = aws_vpc_endpoint.s3.prefix_list_id
}

output "s3_vpc_endpoint_id" {
  description = "S3 gateway endpoint id."
  value       = aws_vpc_endpoint.s3.id
}

output "secretsmanager_vpc_endpoint_id" {
  description = "Secrets Manager interface endpoint id."
  value       = aws_vpc_endpoint.secretsmanager.id
}

output "cognito_vpc_endpoint_id" {
  description = "Cognito IDP interface endpoint id, or null when disabled."
  value       = try(aws_vpc_endpoint.cognito_idp[0].id, null)
}

output "flow_log_group_name" {
  description = "CloudWatch log group receiving VPC flow logs, or null when disabled."
  value       = try(aws_cloudwatch_log_group.flow_logs[0].name, null)
}
