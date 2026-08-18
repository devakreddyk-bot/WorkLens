variable "name_prefix" {
  description = "Prefix applied to the name of every resource in this module (e.g. worklens-prod)."
  type        = string
}

variable "tags" {
  description = "Common tag map applied to every taggable resource."
  type        = map(string)
}

variable "domain_prefix" {
  description = <<-EOT
    Hosted UI domain prefix; the login page becomes
    https://<domain_prefix>.auth.<region>.amazoncognito.com. Must be globally unique.
  EOT
  type        = string
}

variable "callback_urls" {
  description = "Allowed OAuth redirect targets after login (the dashboard /api/auth/callback route)."
  type        = list(string)

  validation {
    condition     = length(var.callback_urls) > 0
    error_message = "At least one callback URL is required."
  }
}

variable "logout_urls" {
  description = "Allowed redirect targets after sign-out."
  type        = list(string)

  validation {
    condition     = length(var.logout_urls) > 0
    error_message = "At least one logout URL is required."
  }
}

variable "password_minimum_length" {
  description = "Minimum dashboard password length."
  type        = number
  default     = 12

  validation {
    condition     = var.password_minimum_length >= 12
    error_message = "password_minimum_length must be at least 12."
  }
}

variable "temporary_password_validity_days" {
  description = "How long an admin-created temporary password stays usable."
  type        = number
  default     = 3
}

variable "advanced_security_mode" {
  description = <<-EOT
    Cognito threat protection: OFF, AUDIT or ENFORCED. OFF by default because it is billed
    per monthly active user on top of the free tier; AUDIT or ENFORCED is recommended once
    the deployment is past pilot.
  EOT
  type        = string
  default     = "OFF"

  validation {
    condition     = contains(["OFF", "AUDIT", "ENFORCED"], var.advanced_security_mode)
    error_message = "advanced_security_mode must be OFF, AUDIT or ENFORCED."
  }
}

variable "deletion_protection" {
  description = "Refuse to delete the user pool. Deleting it orphans every dashboard user."
  type        = bool
  default     = true
}

variable "id_token_validity_minutes" {
  description = "ID token lifetime in minutes."
  type        = number
  default     = 60
}

variable "access_token_validity_minutes" {
  description = "Access token lifetime in minutes."
  type        = number
  default     = 60
}

variable "refresh_token_validity_days" {
  description = "Refresh token lifetime in days."
  type        = number
  default     = 30
}

variable "pre_token_generation_lambda_arn" {
  description = "ARN of the pre-token-generation Lambda that injects the wl:mfa claim (docs/PLAN.md D7)."
  type        = string
}

variable "pre_token_generation_lambda_function_name" {
  description = "Function name of the pre-token-generation Lambda, used for the invoke permission."
  type        = string
}

variable "pre_token_generation_role_name" {
  description = <<-EOT
    Execution role name of the pre-token-generation Lambda. This module attaches its
    cognito-idp:AdminGetUser policy, because the user pool ARN is created here - doing it in
    modules/lambda would make the two modules mutually dependent.
  EOT
  type        = string
}

variable "admin_api_role_name" {
  description = "Execution role name of admin-api, which manages dashboard users in this pool."
  type        = string
}

variable "group_precedence" {
  description = "Cognito group precedence values. Lower wins when a user is in several groups."
  type = object({
    owner    = number
    manager  = number
    employee = number
  })
  default = {
    owner    = 1
    manager  = 5
    employee = 10
  }
}
