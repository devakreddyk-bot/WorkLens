# ---------------------------------------------------------------------------
# Cognito user pool for the dashboard.
#
# MFA is OPTIONAL + software token, not REQUIRED, because Cognito MFA policy is
# pool-wide: requiring it would force TOTP on every employee self-view login.
# Admin MFA is instead enforced server-side (docs/PLAN.md D7) - the
# pre-token-generation trigger injects a wl:mfa claim and the API middleware
# rejects admin routes when it is not "on".
#
# This module also owns the IAM policies that give the pre-token-generation and
# admin-api roles their Cognito permissions. They live here because the user
# pool ARN is created here; granting them from modules/lambda would make the
# two modules depend on each other.
# ---------------------------------------------------------------------------

data "aws_region" "current" {}

resource "aws_cognito_user_pool" "this" {
  name = "${var.name_prefix}-users"

  # Single-company deployment: accounts are created by an owner, never self-signup.
  admin_create_user_config {
    allow_admin_create_user_only = true

    invite_message_template {
      email_subject = "Your WorkLens dashboard account"
      email_message = "You have a WorkLens account. Username: {username} Temporary password: {####}"
      sms_message   = "WorkLens username: {username} temporary password: {####}"
    }
  }

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  deletion_protection      = var.deletion_protection ? "ACTIVE" : "INACTIVE"
  mfa_configuration        = "OPTIONAL"

  username_configuration {
    case_sensitive = false
  }

  software_token_mfa_configuration {
    enabled = true
  }

  password_policy {
    minimum_length                   = var.password_minimum_length
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = var.temporary_password_validity_days
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  user_attribute_update_settings {
    attributes_require_verification_before_update = ["email"]
  }

  schema {
    name                     = "email"
    attribute_data_type      = "String"
    required                 = true
    mutable                  = true
    developer_only_attribute = false

    string_attribute_constraints {
      min_length = 5
      max_length = 254
    }
  }

  user_pool_add_ons {
    advanced_security_mode = var.advanced_security_mode
  }

  email_configuration {
    # Cognito's built-in sender is capped at 50 emails/day, which is ample for a
    # single-company dashboard. Switch to SES by setting email_sending_account
    # to DEVELOPER if invites ever outgrow it.
    email_sending_account = "COGNITO_DEFAULT"
  }

  # V1 trigger: claims are injected into the ID token, which is what the
  # dashboard and the API Gateway Cognito authorizer both read.
  lambda_config {
    pre_token_generation = var.pre_token_generation_lambda_arn
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-users" })
}

resource "aws_cognito_user_pool_domain" "this" {
  domain       = var.domain_prefix
  user_pool_id = aws_cognito_user_pool.this.id
}

# --- Groups ----------------------------------------------------------------
# RBAC is enforced in the API middleware; these groups are the source of the
# cognito:groups claim it reads.

resource "aws_cognito_user_group" "owner" {
  name         = "owner"
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "Full access: settings, users, devices, projects, exports, audit log, erasure"
  precedence   = var.group_precedence.owner
}

resource "aws_cognito_user_group" "manager" {
  name         = "manager"
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "Read all employees; no settings and no user management"
  precedence   = var.group_precedence.manager
}

resource "aws_cognito_user_group" "employee" {
  name         = "employee"
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "Self-view only; scope is rewritten to the caller's own employee_id"
  precedence   = var.group_precedence.employee
}

# --- App client ------------------------------------------------------------

resource "aws_cognito_user_pool_client" "dashboard" {
  name         = "${var.name_prefix}-dashboard"
  user_pool_id = aws_cognito_user_pool.this.id

  # Public client: no secret, authorization code flow with PKCE. PKCE is a
  # property of the authorization request the dashboard sends (code_challenge /
  # code_challenge_method=S256); Cognito accepts it on any public client and it
  # is mandatory for public clients using the code flow.
  generate_secret = false

  allowed_oauth_flows                  = ["code"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]

  callback_urls = var.callback_urls
  logout_urls   = var.logout_urls

  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  token_validity_units {
    id_token      = "minutes"
    access_token  = "minutes"
    refresh_token = "days"
  }

  id_token_validity      = var.id_token_validity_minutes
  access_token_validity  = var.access_token_validity_minutes
  refresh_token_validity = var.refresh_token_validity_days

  read_attributes  = ["email", "email_verified"]
  write_attributes = ["email"]

  auth_session_validity = 3
}

# --- Pre-token-generation trigger wiring -----------------------------------

resource "aws_lambda_permission" "cognito_invoke_pre_token" {
  statement_id  = "AllowCognitoInvokePreTokenGeneration"
  action        = "lambda:InvokeFunction"
  function_name = var.pre_token_generation_lambda_function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.this.arn
}

data "aws_iam_policy_document" "pre_token_generation" {
  statement {
    sid    = "ReadMfaSettingsForCallers"
    effect = "Allow"
    actions = [
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminListGroupsForUser",
    ]
    resources = [aws_cognito_user_pool.this.arn]
  }
}

resource "aws_iam_role_policy" "pre_token_generation" {
  name   = "cognito-read-mfa-settings"
  role   = var.pre_token_generation_role_name
  policy = data.aws_iam_policy_document.pre_token_generation.json
}

# --- Dashboard user management (admin-api) ---------------------------------

data "aws_iam_policy_document" "admin_api_cognito" {
  statement {
    sid    = "ManageDashboardUsers"
    effect = "Allow"
    actions = [
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminUpdateUserAttributes",
      "cognito-idp:AdminAddUserToGroup",
      "cognito-idp:AdminRemoveUserFromGroup",
      "cognito-idp:AdminListGroupsForUser",
      "cognito-idp:AdminDisableUser",
      "cognito-idp:AdminEnableUser",
      "cognito-idp:AdminResetUserPassword",
      "cognito-idp:AdminUserGlobalSignOut",
      "cognito-idp:ListUsers",
      "cognito-idp:ListUsersInGroup",
    ]
    resources = [aws_cognito_user_pool.this.arn]
  }
}

resource "aws_iam_role_policy" "admin_api_cognito" {
  name   = "cognito-user-management"
  role   = var.admin_api_role_name
  policy = data.aws_iam_policy_document.admin_api_cognito.json
}
