output "rule_names" {
  description = "Map of logical schedule name to EventBridge rule name."
  value       = { for key, rule in aws_cloudwatch_event_rule.schedule : key => rule.name }
}

output "rule_arns" {
  description = "Map of logical schedule name to EventBridge rule ARN."
  value       = { for key, rule in aws_cloudwatch_event_rule.schedule : key => rule.arn }
}

output "schedule_expressions" {
  description = "The cron or rate expression in force for each schedule, for the deploy summary."
  value       = { for key, rule in aws_cloudwatch_event_rule.schedule : key => rule.schedule_expression }
}

output "enabled" {
  description = "Whether the schedules are currently enabled."
  value       = var.enabled
}

output "dead_letter_queue_arn" {
  description = "ARN of the queue that receives invocations which exhausted their retries."
  value       = aws_sqs_queue.dead_letter.arn
}

output "dead_letter_queue_url" {
  description = "URL of the dead-letter queue, for inspecting failed runs with the AWS CLI."
  value       = aws_sqs_queue.dead_letter.id
}

output "dead_letter_queue_name" {
  description = "Name of the dead-letter queue, as used in the CloudWatch alarm dimension."
  value       = aws_sqs_queue.dead_letter.name
}
