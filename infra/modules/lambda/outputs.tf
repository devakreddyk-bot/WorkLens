output "functions" {
  description = "Every function keyed by logical name, with its name, ARNs, role and log group."
  value = {
    for key, fn in module.function : key => {
      function_name  = fn.function_name
      arn            = fn.arn
      invoke_arn     = fn.invoke_arn
      role_name      = fn.role_name
      role_arn       = fn.role_arn
      log_group_name = fn.log_group_name
    }
  }
}

output "function_names" {
  description = "Map of logical function key => Lambda function name."
  value       = { for key, fn in module.function : key => fn.function_name }
}

output "function_arns" {
  description = "Map of logical function key => Lambda function ARN."
  value       = { for key, fn in module.function : key => fn.arn }
}

output "invoke_arns" {
  description = "Map of logical function key => invoke ARN for API Gateway AWS_PROXY integrations."
  value       = { for key, fn in module.function : key => fn.invoke_arn }
}

output "role_names" {
  description = "Map of logical function key => execution role name."
  value       = { for key, fn in module.function : key => fn.role_name }
}

output "log_group_names" {
  description = "Map of logical function key => CloudWatch log group name."
  value       = { for key, fn in module.function : key => fn.log_group_name }
}

# --- Individually addressed functions --------------------------------------
# Referenced by modules/auth, modules/api and modules/scheduling. These are
# per-instance outputs so that consumers do not take a dependency on every
# function in the catalogue.

output "pre_token_generation_function_arn" {
  description = "ARN of the Cognito pre-token-generation trigger."
  value       = module.function["pre-token-generation"].arn
}

output "pre_token_generation_function_name" {
  description = "Name of the Cognito pre-token-generation trigger."
  value       = module.function["pre-token-generation"].function_name
}

output "pre_token_generation_role_name" {
  description = "Execution role name of the pre-token-generation trigger; modules/auth attaches its Cognito policy."
  value       = module.function["pre-token-generation"].role_name
}

output "admin_api_role_name" {
  description = "Execution role name of admin-api; modules/auth attaches its Cognito user-management policy."
  value       = module.function["admin-api"].role_name
}

output "aggregate_timesheets_function_name" {
  description = "Name of the nightly aggregation function."
  value       = module.function["aggregate-timesheets"].function_name
}

output "aggregate_timesheets_function_arn" {
  description = "ARN of the nightly aggregation function."
  value       = module.function["aggregate-timesheets"].arn
}

output "retention_sweeper_function_name" {
  description = "Name of the data-retention sweep function."
  value       = module.function["retention-sweeper"].function_name
}

output "retention_sweeper_function_arn" {
  description = "ARN of the data-retention sweep function."
  value       = module.function["retention-sweeper"].arn
}

output "nonce_sweeper_function_name" {
  description = "Name of the hourly replay-nonce expiry function."
  value       = module.function["nonce-sweeper"].function_name
}

output "nonce_sweeper_function_arn" {
  description = "ARN of the hourly replay-nonce expiry function."
  value       = module.function["nonce-sweeper"].arn
}

output "db_migrate_function_name" {
  description = "Name of the in-VPC migration function, or null when disabled."
  value       = try(module.function["db-migrate"].function_name, null)
}

output "expected_artifacts" {
  description = "Zip file names the backend build must place in artifact_dir."
  value       = [for key, _ in local.functions : "${key}.zip"]
}
