output "lambda_error_alarm_names" {
  description = "Map of logical function key to the name of its error alarm."
  value       = { for key, alarm in aws_cloudwatch_metric_alarm.lambda_errors : key => alarm.alarm_name }
}

output "alarm_names" {
  description = "Every alarm this module created, for the deploy summary and for runbook cross-references."
  value = concat(
    [for alarm in aws_cloudwatch_metric_alarm.lambda_errors : alarm.alarm_name],
    [
      aws_cloudwatch_metric_alarm.ingest_throttles.alarm_name,
      aws_cloudwatch_metric_alarm.rds_free_storage.alarm_name,
      aws_cloudwatch_metric_alarm.rds_cpu.alarm_name,
    ],
  )
}

output "rds_free_storage_threshold_bytes" {
  description = "The computed FreeStorageSpace threshold, so the runbook can quote the same number the alarm uses."
  value       = local.rds_free_storage_threshold_bytes
}
