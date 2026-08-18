output "screenshot_bucket_id" {
  description = "Name of the screenshot bucket."
  value       = aws_s3_bucket.screenshots.id
}

output "screenshot_bucket_arn" {
  description = "ARN of the screenshot bucket."
  value       = aws_s3_bucket.screenshots.arn
}

output "screenshot_bucket_regional_domain_name" {
  description = "Regional domain name of the screenshot bucket (used when building presigned URLs)."
  value       = aws_s3_bucket.screenshots.bucket_regional_domain_name
}

output "screenshot_object_prefix" {
  description = "Key prefix the lifecycle expiration rule and the Lambda IAM policies are scoped to."
  value       = "screenshots/"
}

output "cloudtrail_bucket_id" {
  description = "Name of the CloudTrail log bucket."
  value       = aws_s3_bucket.cloudtrail.id
}

output "cloudtrail_bucket_arn" {
  description = "ARN of the CloudTrail log bucket."
  value       = aws_s3_bucket.cloudtrail.arn
}
