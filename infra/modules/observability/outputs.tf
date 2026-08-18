output "rds_kms_key_arn" {
  description = "ARN of the CMK encrypting RDS storage and Secrets Manager secrets."
  value       = aws_kms_key.rds.arn
}

output "rds_kms_key_id" {
  description = "Key id of the RDS CMK."
  value       = aws_kms_key.rds.key_id
}

output "s3_kms_key_arn" {
  description = "ARN of the CMK encrypting S3 screenshot objects."
  value       = aws_kms_key.s3.arn
}

output "s3_kms_key_id" {
  description = "Key id of the S3 CMK (used in SSE-KMS headers on presigned PUTs)."
  value       = aws_kms_key.s3.key_id
}

output "logs_kms_key_arn" {
  description = "ARN of the CMK encrypting CloudWatch log groups, CloudTrail and SNS."
  value       = aws_kms_key.logs.arn
}

output "cloudtrail_arn" {
  description = "ARN of the multi-region CloudTrail trail."
  value       = aws_cloudtrail.this.arn
}

output "cloudtrail_name" {
  description = "Name of the CloudTrail trail."
  value       = aws_cloudtrail.this.name
}

output "device_root_key_secret_arn" {
  description = "ARN of the Secrets Manager secret holding the device root key (docs/PLAN.md D4)."
  value       = aws_secretsmanager_secret.device_root_key.arn
}

output "device_root_key_secret_name" {
  description = "Name of the device root key secret."
  value       = aws_secretsmanager_secret.device_root_key.name
}

output "alarm_topic_arn" {
  description = "SNS topic that receives CloudWatch alarm notifications."
  value       = aws_sns_topic.alarms.arn
}
