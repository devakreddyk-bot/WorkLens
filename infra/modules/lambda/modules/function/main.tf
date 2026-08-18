# ---------------------------------------------------------------------------
# One Lambda function, its own IAM role, and its own KMS-encrypted log group.
#
# Reusable submodule: the parent modules/lambda declares every WorkLens
# function through this, so "one role per function, least privilege" is a
# structural property rather than a convention someone has to remember.
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  region     = data.aws_region.current.name

  in_vpc = length(var.subnet_ids) > 0

  log_group_name = "/aws/lambda/${var.function_name}"
  log_group_arn  = "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/${var.function_name}"

  subnet_arns = [
    for id in var.subnet_ids :
    "arn:${local.partition}:ec2:${local.region}:${local.account_id}:subnet/${id}"
  ]

  security_group_arns = [
    for id in var.security_group_ids :
    "arn:${local.partition}:ec2:${local.region}:${local.account_id}:security-group/${id}"
  ]

  network_interface_arn_pattern = "arn:${local.partition}:ec2:${local.region}:${local.account_id}:network-interface/*"
}

# --- Role ------------------------------------------------------------------

data "aws_iam_policy_document" "assume_role" {
  statement {
    sid     = "LambdaAssumeRole"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "this" {
  name                 = "${var.function_name}-role"
  description          = "Execution role for ${var.function_name}"
  assume_role_policy   = data.aws_iam_policy_document.assume_role.json
  max_session_duration = 3600

  tags = var.tags
}

# --- Logging -----------------------------------------------------------------

resource "aws_cloudwatch_log_group" "this" {
  name              = local.log_group_name
  retention_in_days = var.log_retention_days
  kms_key_id        = var.log_kms_key_arn

  tags = var.tags
}

data "aws_iam_policy_document" "logs" {
  statement {
    sid    = "WriteOwnLogStream"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    # Scoped to this function's own log group. logs:CreateLogGroup is
    # deliberately absent: the group is created by Terraform above.
    resources = [
      local.log_group_arn,
      "${local.log_group_arn}:*",
    ]
  }
}

resource "aws_iam_role_policy" "logs" {
  name   = "logs"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.logs.json
}

# --- VPC networking ---------------------------------------------------------

data "aws_iam_policy_document" "vpc" {
  count = local.in_vpc ? 1 : 0

  statement {
    sid    = "DescribeNetworkResources"
    effect = "Allow"
    actions = [
      "ec2:DescribeNetworkInterfaces",
      "ec2:DescribeSubnets",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeVpcs",
    ]
    # This block is the documented minimum for a VPC-attached Lambda: without it the
    # function cannot create the ENI it needs to reach the private subnets.
    # iam-wildcard-ok: EC2 Describe* actions have no resource-level permissions, so no narrower ARN exists to write; they are read-only and mutate nothing.
    resources = ["*"]
  }

  statement {
    sid     = "CreateEniInOwnSubnets"
    effect  = "Allow"
    actions = ["ec2:CreateNetworkInterface"]
    resources = concat(
      local.subnet_arns,
      local.security_group_arns,
      [local.network_interface_arn_pattern],
    )
  }

  statement {
    sid    = "ManageOwnEnis"
    effect = "Allow"
    actions = [
      "ec2:DeleteNetworkInterface",
      "ec2:AssignPrivateIpAddresses",
      "ec2:UnassignPrivateIpAddresses",
      "ec2:CreateTags",
    ]
    resources = [local.network_interface_arn_pattern]
  }
}

resource "aws_iam_role_policy" "vpc" {
  count = local.in_vpc ? 1 : 0

  name   = "vpc-networking"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.vpc[0].json
}

# --- Function-specific permissions -----------------------------------------

data "aws_iam_policy_document" "extra" {
  count = length(var.policy_statements) > 0 ? 1 : 0

  dynamic "statement" {
    for_each = var.policy_statements

    content {
      sid       = statement.value.sid
      effect    = "Allow"
      actions   = statement.value.actions
      resources = statement.value.resources

      dynamic "condition" {
        for_each = statement.value.conditions

        content {
          test     = condition.value.test
          variable = condition.value.variable
          values   = condition.value.values
        }
      }
    }
  }
}

resource "aws_iam_role_policy" "extra" {
  count = length(var.policy_statements) > 0 ? 1 : 0

  name   = "function"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.extra[0].json
}

# --- Function ---------------------------------------------------------------

resource "aws_lambda_function" "this" {
  function_name = var.function_name
  description   = var.description
  role          = aws_iam_role.this.arn

  package_type  = "Zip"
  filename      = var.artifact_path
  handler       = var.handler
  runtime       = var.runtime
  architectures = [var.architecture]
  layers        = var.layers

  # try() keeps `terraform validate`/`plan` working before the backend build
  # has produced the artifact; once the zip exists, its hash drives updates.
  source_code_hash = try(filebase64sha256(var.artifact_path), null)

  memory_size                    = var.memory_size
  timeout                        = var.timeout
  reserved_concurrent_executions = var.reserved_concurrent_executions

  ephemeral_storage {
    size = var.ephemeral_storage_size
  }

  dynamic "environment" {
    for_each = length(var.environment_variables) > 0 ? [1] : []

    content {
      variables = var.environment_variables
    }
  }

  dynamic "vpc_config" {
    for_each = local.in_vpc ? [1] : []

    content {
      subnet_ids         = var.subnet_ids
      security_group_ids = var.security_group_ids
    }
  }

  logging_config {
    log_format            = "JSON"
    application_log_level = var.log_level
    system_log_level      = "WARN"
    log_group             = aws_cloudwatch_log_group.this.name
  }

  tracing_config {
    # X-Ray would require an xray:PutTraceSegments statement on Resource "*".
    # Structured JSON logs plus CloudWatch metrics cover the operational need
    # without that grant; see modules/lambda/README.md.
    mode = "PassThrough"
  }

  tags = var.tags

  # The ENI policy must exist before Lambda tries to attach the function to
  # the VPC, otherwise the first create fails with an authorization error.
  depends_on = [
    aws_cloudwatch_log_group.this,
    aws_iam_role_policy.logs,
    aws_iam_role_policy.vpc,
  ]
}
