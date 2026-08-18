# ---------------------------------------------------------------------------
# API Gateway REST API (regional).
#
# REST rather than HTTP API because AWS WAF cannot be attached to an HTTP API,
# and docs/PLAN.md section 6 requires a WebACL on the API - see deviation D2.
#
# Two authorizers:
#   * device  - REQUEST Lambda authorizer running the HMAC checks (D3). Result
#               caching is disabled: every request carries its own signature,
#               timestamp and nonce, so a cached decision would defeat replay
#               protection.
#   * dashboard - COGNITO_USER_POOLS on the Authorization header.
#
# /v1/device/enroll is the only unauthenticated route. It is protected by
# single-use enrollment tokens, WAF rate limiting and stage throttling.
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  region     = data.aws_region.current.name
  partition  = data.aws_partition.current.partition
  account_id = data.aws_caller_identity.current.account_id

  # Every resource path below the stage, one entry per path segment level.
  api_paths = [
    # Device API (HMAC auth)
    "device",
    "device/enroll",
    "device/config",
    "device/events",
    "device/screenshots",
    "device/screenshots/{id}",
    "device/screenshots/{id}/complete",
    "device/heartbeat",
    "device/notice-ack",

    # Dashboard API (Cognito auth)
    "me",
    "overview",
    "employees",
    "employees/{id}",
    "employees/{id}/timesheets",
    "employees/{id}/activity",
    "employees/{id}/screenshots",
    "employees/{id}/screenshots/{sid}",
    "employees/{id}/screenshots/{sid}/url",
    "timesheets",
    "projects",
    "projects/{id}",
    "projects/{id}/rules",
    "projects/{id}/rules/{rid}",
    "config",
    "devices",
    "devices/enrollment-tokens",
    "devices/{id}",
    "devices/{id}/revoke",
    "aggregation",
    "aggregation/run",
    "reports",
    "reports/export",
    "audit-log",
    "users",
    "users/{id}",
    "deletion-requests",
    "deletion-requests/{id}",
    "deletion-requests/{id}/execute",
  ]

  paths_by_depth = {
    for depth in [1, 2, 3, 4, 5] :
    depth => [for p in local.api_paths : p if length(split("/", p)) == depth]
  }

  resource_ids = merge(
    { for p, r in aws_api_gateway_resource.d1 : p => r.id },
    { for p, r in aws_api_gateway_resource.d2 : p => r.id },
    { for p, r in aws_api_gateway_resource.d3 : p => r.id },
    { for p, r in aws_api_gateway_resource.d4 : p => r.id },
    { for p, r in aws_api_gateway_resource.d5 : p => r.id },
  )

  # ---- routes ------------------------------------------------------------
  # auth: "device" -> HMAC Lambda authorizer, "cognito" -> user pool
  # authorizer, "none" -> open (enrollment only).
  routes = {
    # Device API
    "POST /device/enroll"                    = { path = "device/enroll", method = "POST", function = "enroll", auth = "none" }
    "GET /device/config"                     = { path = "device/config", method = "GET", function = "device-config", auth = "device" }
    "POST /device/events"                    = { path = "device/events", method = "POST", function = "ingest-events", auth = "device" }
    "POST /device/screenshots"               = { path = "device/screenshots", method = "POST", function = "screenshot-presign", auth = "device" }
    "POST /device/screenshots/{id}/complete" = { path = "device/screenshots/{id}/complete", method = "POST", function = "screenshot-complete", auth = "device" }
    "POST /device/heartbeat"                 = { path = "device/heartbeat", method = "POST", function = "heartbeat", auth = "device" }
    "POST /device/notice-ack"                = { path = "device/notice-ack", method = "POST", function = "notice-ack", auth = "device" }

    # Dashboard API - reads
    "GET /me"                                   = { path = "me", method = "GET", function = "reporting-api", auth = "cognito" }
    "GET /overview"                             = { path = "overview", method = "GET", function = "reporting-api", auth = "cognito" }
    "GET /employees"                            = { path = "employees", method = "GET", function = "reporting-api", auth = "cognito" }
    "GET /employees/{id}/timesheets"            = { path = "employees/{id}/timesheets", method = "GET", function = "reporting-api", auth = "cognito" }
    "GET /employees/{id}/activity"              = { path = "employees/{id}/activity", method = "GET", function = "reporting-api", auth = "cognito" }
    "GET /employees/{id}/screenshots"           = { path = "employees/{id}/screenshots", method = "GET", function = "reporting-api", auth = "cognito" }
    "GET /employees/{id}/screenshots/{sid}/url" = { path = "employees/{id}/screenshots/{sid}/url", method = "GET", function = "reporting-api", auth = "cognito" }
    "GET /timesheets"                           = { path = "timesheets", method = "GET", function = "reporting-api", auth = "cognito" }
    "GET /reports/export"                       = { path = "reports/export", method = "GET", function = "reporting-api", auth = "cognito" }

    # Dashboard API - writes and administration
    "POST /employees"                      = { path = "employees", method = "POST", function = "admin-api", auth = "cognito" }
    "PATCH /employees/{id}"                = { path = "employees/{id}", method = "PATCH", function = "admin-api", auth = "cognito" }
    "GET /projects"                        = { path = "projects", method = "GET", function = "admin-api", auth = "cognito" }
    "POST /projects"                       = { path = "projects", method = "POST", function = "admin-api", auth = "cognito" }
    "PATCH /projects/{id}"                 = { path = "projects/{id}", method = "PATCH", function = "admin-api", auth = "cognito" }
    "DELETE /projects/{id}"                = { path = "projects/{id}", method = "DELETE", function = "admin-api", auth = "cognito" }
    "GET /projects/{id}/rules"             = { path = "projects/{id}/rules", method = "GET", function = "admin-api", auth = "cognito" }
    "POST /projects/{id}/rules"            = { path = "projects/{id}/rules", method = "POST", function = "admin-api", auth = "cognito" }
    "DELETE /projects/{id}/rules/{rid}"    = { path = "projects/{id}/rules/{rid}", method = "DELETE", function = "admin-api", auth = "cognito" }
    "GET /config"                          = { path = "config", method = "GET", function = "admin-api", auth = "cognito" }
    "PUT /config"                          = { path = "config", method = "PUT", function = "admin-api", auth = "cognito" }
    "GET /devices"                         = { path = "devices", method = "GET", function = "admin-api", auth = "cognito" }
    "POST /devices/enrollment-tokens"      = { path = "devices/enrollment-tokens", method = "POST", function = "admin-api", auth = "cognito" }
    "POST /devices/{id}/revoke"            = { path = "devices/{id}/revoke", method = "POST", function = "admin-api", auth = "cognito" }
    "GET /audit-log"                       = { path = "audit-log", method = "GET", function = "admin-api", auth = "cognito" }
    "GET /users"                           = { path = "users", method = "GET", function = "admin-api", auth = "cognito" }
    "POST /users"                          = { path = "users", method = "POST", function = "admin-api", auth = "cognito" }
    "PATCH /users/{id}"                    = { path = "users/{id}", method = "PATCH", function = "admin-api", auth = "cognito" }
    "GET /deletion-requests"               = { path = "deletion-requests", method = "GET", function = "admin-api", auth = "cognito" }
    "POST /deletion-requests"              = { path = "deletion-requests", method = "POST", function = "admin-api", auth = "cognito" }
    "POST /deletion-requests/{id}/execute" = { path = "deletion-requests/{id}/execute", method = "POST", function = "admin-api", auth = "cognito" }

    # On-demand aggregation is routed straight at the aggregation function
    # rather than proxied through admin-api: an in-VPC Lambda cannot reach the
    # Lambda control plane without a NAT gateway or another interface endpoint.
    "POST /aggregation/run" = { path = "aggregation/run", method = "POST", function = "aggregate-timesheets", auth = "cognito" }
  }

  # Distinct functions actually wired to a route; one invoke permission each.
  integration_functions = distinct([for r in local.routes : r.function])

  # Paths that need a CORS preflight: the dashboard is a different origin.
  cors_paths = distinct([for r in local.routes : r.path if r.auth == "cognito"])

  cors_allow_headers = "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token,Idempotency-Key"
  cors_allow_methods = "GET,POST,PATCH,PUT,DELETE,OPTIONS"
  cors_allow_origin  = "'${var.cors_allowed_origins[0]}'"

  create_custom_domain = var.custom_domain_name != null && var.acm_certificate_arn != null
}

resource "aws_api_gateway_rest_api" "this" {
  name        = "${var.name_prefix}-api"
  description = "WorkLens device and dashboard API"

  endpoint_configuration {
    types = [var.endpoint_type]
  }

  minimum_compression_size = var.minimum_compression_size

  # Bodies are JSON only; anything else is a client error, not something to
  # forward to a handler.
  binary_media_types = []

  tags = merge(var.tags, { Name = "${var.name_prefix}-api" })
}

# --- Resource tree ---------------------------------------------------------
# Built one depth level at a time: a single for_each cannot reference its own
# instances to find a parent.

resource "aws_api_gateway_resource" "d1" {
  for_each = toset(local.paths_by_depth[1])

  rest_api_id = aws_api_gateway_rest_api.this.id
  parent_id   = aws_api_gateway_rest_api.this.root_resource_id
  path_part   = each.value
}

resource "aws_api_gateway_resource" "d2" {
  for_each = toset(local.paths_by_depth[2])

  rest_api_id = aws_api_gateway_rest_api.this.id
  parent_id   = aws_api_gateway_resource.d1[join("/", slice(split("/", each.value), 0, 1))].id
  path_part   = element(split("/", each.value), 1)
}

resource "aws_api_gateway_resource" "d3" {
  for_each = toset(local.paths_by_depth[3])

  rest_api_id = aws_api_gateway_rest_api.this.id
  parent_id   = aws_api_gateway_resource.d2[join("/", slice(split("/", each.value), 0, 2))].id
  path_part   = element(split("/", each.value), 2)
}

resource "aws_api_gateway_resource" "d4" {
  for_each = toset(local.paths_by_depth[4])

  rest_api_id = aws_api_gateway_rest_api.this.id
  parent_id   = aws_api_gateway_resource.d3[join("/", slice(split("/", each.value), 0, 3))].id
  path_part   = element(split("/", each.value), 3)
}

resource "aws_api_gateway_resource" "d5" {
  for_each = toset(local.paths_by_depth[5])

  rest_api_id = aws_api_gateway_rest_api.this.id
  parent_id   = aws_api_gateway_resource.d4[join("/", slice(split("/", each.value), 0, 4))].id
  path_part   = element(split("/", each.value), 4)
}

# --- Authorizers -----------------------------------------------------------

data "aws_iam_policy_document" "authorizer_assume" {
  statement {
    sid     = "ApiGatewayAssumeRole"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["apigateway.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "authorizer_invoke" {
  name               = "${var.name_prefix}-api-authorizer-invoke"
  description        = "Lets API Gateway invoke the device HMAC authorizer"
  assume_role_policy = data.aws_iam_policy_document.authorizer_assume.json

  tags = var.tags
}

data "aws_iam_policy_document" "authorizer_invoke" {
  statement {
    sid       = "InvokeDeviceAuthorizer"
    effect    = "Allow"
    actions   = ["lambda:InvokeFunction"]
    resources = ["arn:${local.partition}:lambda:${local.region}:${local.account_id}:function:${var.function_names["device-authorizer"]}"]
  }
}

resource "aws_iam_role_policy" "authorizer_invoke" {
  name   = "invoke-device-authorizer"
  role   = aws_iam_role.authorizer_invoke.id
  policy = data.aws_iam_policy_document.authorizer_invoke.json
}

resource "aws_api_gateway_authorizer" "device" {
  name                   = "${var.name_prefix}-device-hmac"
  rest_api_id            = aws_api_gateway_rest_api.this.id
  type                   = "REQUEST"
  authorizer_uri         = var.device_authorizer_invoke_arn
  authorizer_credentials = aws_iam_role.authorizer_invoke.arn
  identity_source        = "method.request.header.X-WL-Device,method.request.header.X-WL-Timestamp,method.request.header.X-WL-Nonce,method.request.header.X-WL-Signature"

  # Zero TTL: the authorizer verifies a per-request signature, timestamp window
  # and nonce. Caching a decision would make replay protection meaningless.
  authorizer_result_ttl_in_seconds = 0
}

resource "aws_api_gateway_authorizer" "dashboard" {
  name            = "${var.name_prefix}-dashboard-cognito"
  rest_api_id     = aws_api_gateway_rest_api.this.id
  type            = "COGNITO_USER_POOLS"
  provider_arns   = [var.cognito_user_pool_arn]
  identity_source = "method.request.header.Authorization"
}

# --- Methods and integrations ----------------------------------------------

resource "aws_api_gateway_method" "this" {
  for_each = local.routes

  rest_api_id      = aws_api_gateway_rest_api.this.id
  resource_id      = local.resource_ids[each.value.path]
  http_method      = each.value.method
  api_key_required = false

  authorization = each.value.auth == "device" ? "CUSTOM" : (each.value.auth == "cognito" ? "COGNITO_USER_POOLS" : "NONE")
  authorizer_id = each.value.auth == "device" ? aws_api_gateway_authorizer.device.id : (each.value.auth == "cognito" ? aws_api_gateway_authorizer.dashboard.id : null)

  request_parameters = each.value.auth == "device" ? {
    "method.request.header.X-WL-Device"    = true
    "method.request.header.X-WL-Timestamp" = true
    "method.request.header.X-WL-Nonce"     = true
    "method.request.header.X-WL-Signature" = true
  } : {}
}

resource "aws_api_gateway_integration" "this" {
  for_each = local.routes

  rest_api_id = aws_api_gateway_rest_api.this.id
  resource_id = local.resource_ids[each.value.path]
  http_method = aws_api_gateway_method.this[each.key].http_method

  # Lambda proxy: handlers own routing, status codes and headers, which is what
  # makes swapping REST for HTTP API later a module-only change (D2).
  type                    = "AWS_PROXY"
  integration_http_method = "POST"
  uri                     = var.invoke_arns[each.value.function]
  timeout_milliseconds    = 29000
}

resource "aws_lambda_permission" "api_invoke" {
  for_each = toset(local.integration_functions)

  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.function_names[each.value]
  principal     = "apigateway.amazonaws.com"

  # Scoped to this API; the stage/method wildcard is how API Gateway source
  # ARNs work for a proxy integration serving many routes.
  source_arn = "${aws_api_gateway_rest_api.this.execution_arn}/*/*"
}

# --- CORS preflight --------------------------------------------------------

resource "aws_api_gateway_method" "cors" {
  for_each = toset(local.cors_paths)

  rest_api_id      = aws_api_gateway_rest_api.this.id
  resource_id      = local.resource_ids[each.value]
  http_method      = "OPTIONS"
  authorization    = "NONE"
  api_key_required = false
}

resource "aws_api_gateway_integration" "cors" {
  for_each = toset(local.cors_paths)

  rest_api_id = aws_api_gateway_rest_api.this.id
  resource_id = local.resource_ids[each.value]
  http_method = aws_api_gateway_method.cors[each.value].http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "cors" {
  for_each = toset(local.cors_paths)

  rest_api_id = aws_api_gateway_rest_api.this.id
  resource_id = local.resource_ids[each.value]
  http_method = aws_api_gateway_method.cors[each.value].http_method
  status_code = "204"

  response_models = {
    "application/json" = "Empty"
  }

  response_parameters = {
    "method.response.header.Access-Control-Allow-Origin"      = true
    "method.response.header.Access-Control-Allow-Methods"     = true
    "method.response.header.Access-Control-Allow-Headers"     = true
    "method.response.header.Access-Control-Allow-Credentials" = true
    "method.response.header.Access-Control-Max-Age"           = true
    "method.response.header.Vary"                             = true
  }
}

resource "aws_api_gateway_integration_response" "cors" {
  for_each = toset(local.cors_paths)

  rest_api_id = aws_api_gateway_rest_api.this.id
  resource_id = local.resource_ids[each.value]
  http_method = aws_api_gateway_method.cors[each.value].http_method
  status_code = aws_api_gateway_method_response.cors[each.value].status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Origin"      = local.cors_allow_origin
    "method.response.header.Access-Control-Allow-Methods"     = "'${local.cors_allow_methods}'"
    "method.response.header.Access-Control-Allow-Headers"     = "'${local.cors_allow_headers}'"
    "method.response.header.Access-Control-Allow-Credentials" = "'true'"
    "method.response.header.Access-Control-Max-Age"           = "'600'"
    "method.response.header.Vary"                             = "'Origin'"
  }

  depends_on = [aws_api_gateway_integration.cors]
}

# Error responses generated by API Gateway itself (401/403/429/5xx) must also
# carry CORS headers or the dashboard sees an opaque network failure.
resource "aws_api_gateway_gateway_response" "default_4xx" {
  rest_api_id   = aws_api_gateway_rest_api.this.id
  response_type = "DEFAULT_4XX"

  response_parameters = {
    "gatewayresponse.header.Access-Control-Allow-Origin"  = local.cors_allow_origin
    "gatewayresponse.header.Access-Control-Allow-Headers" = "'${local.cors_allow_headers}'"
  }
}

resource "aws_api_gateway_gateway_response" "default_5xx" {
  rest_api_id   = aws_api_gateway_rest_api.this.id
  response_type = "DEFAULT_5XX"

  response_parameters = {
    "gatewayresponse.header.Access-Control-Allow-Origin"  = local.cors_allow_origin
    "gatewayresponse.header.Access-Control-Allow-Headers" = "'${local.cors_allow_headers}'"
  }
}

# --- Logging ---------------------------------------------------------------

resource "aws_cloudwatch_log_group" "access" {
  name              = "/aws/apigateway/${var.name_prefix}/access"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.log_kms_key_arn

  tags = var.tags
}

# Execution logs go to this exact group name; API Gateway derives it from the
# API id and stage and will not use any other.
resource "aws_cloudwatch_log_group" "execution" {
  name              = "API-Gateway-Execution-Logs_${aws_api_gateway_rest_api.this.id}/${var.stage_name}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.log_kms_key_arn

  tags = var.tags
}

# --- Deployment and stage --------------------------------------------------

resource "aws_api_gateway_deployment" "this" {
  rest_api_id = aws_api_gateway_rest_api.this.id

  triggers = {
    redeployment = sha1(jsonencode([
      local.api_paths,
      local.routes,
      local.cors_paths,
      var.cors_allowed_origins,
      aws_api_gateway_authorizer.device.id,
      aws_api_gateway_authorizer.dashboard.id,
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [
    aws_api_gateway_method.this,
    aws_api_gateway_integration.this,
    aws_api_gateway_method.cors,
    aws_api_gateway_integration.cors,
    aws_api_gateway_method_response.cors,
    aws_api_gateway_integration_response.cors,
  ]
}

resource "aws_api_gateway_stage" "this" {
  rest_api_id   = aws_api_gateway_rest_api.this.id
  deployment_id = aws_api_gateway_deployment.this.id
  stage_name    = var.stage_name
  description   = "WorkLens ${var.stage_name} stage"

  # Nothing here is cacheable: every response is tenant-scoped.
  cache_cluster_enabled = false
  xray_tracing_enabled  = false

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn

    format = jsonencode({
      requestId          = "$context.requestId"
      extendedRequestId  = "$context.extendedRequestId"
      requestTime        = "$context.requestTime"
      httpMethod         = "$context.httpMethod"
      resourcePath       = "$context.resourcePath"
      path               = "$context.path"
      status             = "$context.status"
      protocol           = "$context.protocol"
      responseLength     = "$context.responseLength"
      integrationLatency = "$context.integrationLatency"
      responseLatency    = "$context.responseLatency"
      sourceIp           = "$context.identity.sourceIp"
      userAgent          = "$context.identity.userAgent"
      deviceId           = "$context.authorizer.deviceId"
      cognitoSub         = "$context.authorizer.claims.sub"
      errorMessage       = "$context.error.message"
      wafStatus          = "$context.wafResponseCode"
    })
  }

  tags = var.tags

  depends_on = [
    aws_cloudwatch_log_group.access,
    aws_cloudwatch_log_group.execution,
    aws_api_gateway_account.this,
  ]
}

resource "aws_api_gateway_method_settings" "all" {
  rest_api_id = aws_api_gateway_rest_api.this.id
  stage_name  = aws_api_gateway_stage.this.stage_name
  method_path = "*/*"

  settings {
    metrics_enabled        = var.metrics_enabled
    logging_level          = var.logging_level
    data_trace_enabled     = var.data_trace_enabled
    throttling_rate_limit  = var.throttle_rate_limit
    throttling_burst_limit = var.throttle_burst_limit
    caching_enabled        = false
  }
}

# --- Optional custom domain ------------------------------------------------

resource "aws_api_gateway_domain_name" "this" {
  count = local.create_custom_domain ? 1 : 0

  domain_name              = var.custom_domain_name
  regional_certificate_arn = var.acm_certificate_arn
  security_policy          = "TLS_1_2"

  endpoint_configuration {
    types = ["REGIONAL"]
  }

  tags = var.tags
}

resource "aws_api_gateway_base_path_mapping" "this" {
  count = local.create_custom_domain ? 1 : 0

  api_id      = aws_api_gateway_rest_api.this.id
  stage_name  = aws_api_gateway_stage.this.stage_name
  domain_name = aws_api_gateway_domain_name.this[0].domain_name
  base_path   = var.stage_name
}

# --- Account-level logging role --------------------------------------------
# API Gateway will not write any logs until the region's account settings name
# a role it can assume. This is per-account and per-region, hence the toggle.

data "aws_iam_policy_document" "cloudwatch_assume" {
  count = var.manage_account_cloudwatch_role ? 1 : 0

  statement {
    sid     = "ApiGatewayAssumeRole"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["apigateway.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cloudwatch" {
  count = var.manage_account_cloudwatch_role ? 1 : 0

  name               = "${var.name_prefix}-apigw-cloudwatch"
  description        = "Account-level role API Gateway uses to write access and execution logs"
  assume_role_policy = data.aws_iam_policy_document.cloudwatch_assume[0].json

  tags = var.tags
}

data "aws_iam_policy_document" "cloudwatch" {
  count = var.manage_account_cloudwatch_role ? 1 : 0

  statement {
    sid    = "DescribeLogGroups"
    effect = "Allow"
    actions = [
      "logs:DescribeLogGroups",
    ]
    # iam-wildcard-ok: logs:DescribeLogGroups has no resource-level permissions; it returns log-group metadata only and cannot read log contents.
    resources = ["*"]
  }

  statement {
    sid    = "WriteApiGatewayLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:DescribeLogStreams",
      "logs:PutLogEvents",
      "logs:GetLogEvents",
      "logs:FilterLogEvents",
    ]
    resources = [
      "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:API-Gateway-Execution-Logs_*",
      "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:API-Gateway-Execution-Logs_*:*",
      aws_cloudwatch_log_group.access.arn,
      "${aws_cloudwatch_log_group.access.arn}:*",
    ]
  }
}

resource "aws_iam_role_policy" "cloudwatch" {
  count = var.manage_account_cloudwatch_role ? 1 : 0

  name   = "apigw-cloudwatch-logs"
  role   = aws_iam_role.cloudwatch[0].id
  policy = data.aws_iam_policy_document.cloudwatch[0].json
}

resource "aws_api_gateway_account" "this" {
  count = var.manage_account_cloudwatch_role ? 1 : 0

  cloudwatch_role_arn = aws_iam_role.cloudwatch[0].arn

  depends_on = [aws_iam_role_policy.cloudwatch]
}
