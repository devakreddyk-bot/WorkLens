# `api`

Owns the public HTTP surface: a regional API Gateway REST API, the whole resource tree built from a declarative path list, one method and `AWS_PROXY` integration per route, the Cognito user-pool authorizer for dashboard routes, `lambda:InvokeFunction` permissions for each integrated function, CORS preflight methods and gateway-response headers, KMS-encrypted access and execution log groups, the deployment and stage with its throttling and logging settings, an optional custom domain, and the account-level API Gateway CloudWatch role. It does not own the Lambdas, the WAF WebACL (that module associates itself with the stage ARN exported here), or the Cognito pool.

## Design notes

**REST API, not HTTP API — this is deviation D2.** §6 requires a WAF WebACL on the API, and AWS WAF cannot be attached to an API Gateway HTTP API; it attaches to REST APIs, ALBs, AppSync and CloudFront. The two ways to satisfy the requirement were REST-with-WAF or HTTP-API-behind-CloudFront-with-WAF, and REST won: fewer moving parts, and no cache layer in front of an API where nothing is cacheable. The cost delta is roughly $3.50 vs $1.40 per month at the projected volume. `endpoint_type` defaults to `REGIONAL` and its description says why — an edge-optimised endpoint cannot take a direct WebACL association either. Because every integration is Lambda proxy, handlers own routing, status codes and headers, so a future swap back to HTTP API is a change to this module and nothing else.

**There is one authorizer, and the device routes deliberately have none at the gateway.** The header comment records that a device Lambda authorizer was planned and removed, and the reason is a hard API Gateway constraint: a REST API Lambda authorizer is never given the request body, while the agent's HMAC signature covers `sha256(body)` (D3). The check is therefore impossible in an authorizer, and HMAC verification happens in-handler via `src/middleware/deviceAuth.ts`. A second reason is recorded next to the `authorization` argument: authorizer result caching would have to be disabled anyway, because every request carries a fresh nonce, so every lookup would be a cache miss — an extra Lambda invocation per request for nothing.

**Device routes still declare their headers as required.** `request_parameters` marks `X-WL-Device`, `X-WL-Timestamp`, `X-WL-Nonce` and `X-WL-Signature` as required on every `auth = "device"` method. The gateway rejects a request missing any of them before it reaches a Lambda, which is a free filter against unsigned traffic even though the gateway cannot validate the signature itself.

**`/device/enroll` is the only route with no authentication of any kind,** and necessarily so — the device has no secret yet. The header comment names its three compensating controls: single-use enrollment tokens (only `sha256(token)` is stored), the dedicated WAF enroll rate rule, and stage throttling.

**The resource tree is built one depth level at a time.** `aws_api_gateway_resource` needs a `parent_id`, and a single `for_each` cannot reference its own instances to find its parent — so there are five near-identical resources, `d1` through `d5`, each looking its parent up in the previous level's map, and `local.resource_ids` merges all five back into one path→id lookup. The `api_paths` list is written with one entry per *path segment level*, which is why intermediate segments that carry no methods (`device`, `employees/{id}`, `reports`) still appear: without them the child has no parent to attach to.

**Routes are data, and the route table is a single source of truth.** `local.routes` is one entry per `"<METHOD> <path>"` with its target function and auth mode. Methods, integrations, CORS paths, invoke permissions and the redeployment trigger are all derived from it, and it is exported as the `routes` output so the wiring can be diffed against `docs/PLAN.md` §4 without reading Terraform. Adding a route means one line plus, if it is a new path, an `api_paths` entry.

**`POST /aggregation/run` points straight at `aggregate-timesheets` rather than being proxied through `admin-api`.** The comment gives the reason and it follows from D6: `admin-api` is in the VPC with no NAT gateway, so it cannot reach the Lambda control plane to invoke another function without adding another interface endpoint. Routing the gateway directly at the target function avoids the endpoint entirely. The trade-off is that the RBAC check for this route lives in the aggregation function rather than alongside the other admin routes.

**One invoke permission per distinct function, with a `/*/*` source ARN.** `local.integration_functions` is `distinct()` over the route table, so `reporting-api` and `admin-api` get one statement each rather than one per route. The stage-and-method wildcard is how proxy integrations serving many routes are expressed; narrowing it would mean a statement per method, and the resource policy would hit its size limit long before the route table stopped growing.

**CORS is hand-built, and the gateway's own error responses are patched too.** REST APIs have no `cors` block, so each dashboard path gets an `OPTIONS` method with a `MOCK` integration returning 204. The important detail is the two `aws_api_gateway_gateway_response` resources: 401, 403, 429 and 5xx responses generated by API Gateway itself never reach a handler and therefore carry no handler-set CORS headers, which the browser surfaces as an opaque network error rather than the actual status. Adding `Access-Control-Allow-Origin` to `DEFAULT_4XX` and `DEFAULT_5XX` is what makes a 403 debuggable from the dashboard. `Vary: Origin` is set on the preflight so a shared cache cannot serve one origin's response to another.

**`data_trace_enabled` has a validation rule that only permits `false`.** Data tracing logs full request and response bodies, and on this API bodies are employee activity data — window titles, hostnames, timestamps. Making it a variable but validating it to `false` is a deliberate choice: the knob is visible and documented, and turning it on requires editing the module rather than a tfvars line, which is the right amount of friction for something that would copy monitored data into CloudWatch.

**The execution log group name is not a choice.** API Gateway derives `API-Gateway-Execution-Logs_<api-id>/<stage>` and will use no other group, so the resource declares exactly that name. Declaring it in Terraform is what gets it a CMK and a retention setting instead of the unencrypted, never-expiring group API Gateway would create.

**Logging needs an account-level role, hence `manage_account_cloudwatch_role`.** `aws_api_gateway_account` is a per-account, per-region singleton: without a role named there, API Gateway writes no access or execution logs at all, silently. The module creates and sets it by default, and the toggle exists because two stacks in the same account and region would otherwise fight over the same setting. The stage `depends_on` it so the first apply does not produce a stage with logging configured and nothing arriving.

**The redeployment trigger is content-hashed.** REST API deployments are immutable snapshots, and the classic failure is changing a method and never redeploying. `triggers.redeployment` is a `sha1(jsonencode(...))` over the path list, the route table, the CORS paths, the allowed origins and the authorizer id, with `create_before_destroy` so the new deployment exists before the old one is removed.

**Caching and X-Ray are both off, explicitly.** `cache_cluster_enabled = false` with the comment "nothing here is cacheable: every response is tenant-scoped" — a cache in front of `org_id`-scoped responses is a cross-tenant leak waiting for a cache-key mistake. `caching_enabled = false` in the method settings says the same thing at the method level.

**`binary_media_types = []`.** Bodies are JSON; the API never carries image bytes, because screenshots go direct to S3 through presigned PUTs. Anything non-JSON is a client error rather than something to base64-encode and hand to a handler.

**`timeout_milliseconds = 29000`** on every integration sits just under API Gateway's 29-second hard ceiling, so a slow handler produces an integration timeout the gateway reports rather than an ambiguous connection reset.

## Inputs

| Name | Type | Default | Description |
|---|---|---|---|
| `name_prefix` | `string` | required | Prefix applied to the name of every resource in this module (e.g. `worklens-prod`). |
| `tags` | `map(string)` | required | Common tag map applied to every taggable resource. |
| `stage_name` | `string` | `"v1"` | Stage name, which is also the first path segment of the public URL. `v1` makes the base URL `https://<api-id>.execute-api.<region>.amazonaws.com/v1` and the routes `/v1/device/events` etc., matching `docs/PLAN.md` §4. |
| `invoke_arns` | `map(string)` | required | Map of logical function key => Lambda invoke ARN, from `modules/lambda`. |
| `function_names` | `map(string)` | required | Map of logical function key => Lambda function name, from `modules/lambda`. |
| `cognito_user_pool_arn` | `string` | required | ARN of the Cognito user pool backing the dashboard authorizer. |
| `log_kms_key_arn` | `string` | required | CMK ARN encrypting the access and execution log groups. |
| `log_retention_days` | `number` | `30` | CloudWatch Logs retention in days for API access and execution logs. |
| `throttle_rate_limit` | `number` | `200` | Steady-state request rate ceiling for the stage, in requests per second. |
| `throttle_burst_limit` | `number` | `400` | Burst capacity for the stage, in requests. |
| `logging_level` | `string` | `"INFO"` | Execution log verbosity: `OFF`, `ERROR` or `INFO`. Validated against those three values. |
| `data_trace_enabled` | `bool` | `false` | Log full request/response bodies for every call. Must stay `false`: bodies contain employee activity data, and CloudWatch is not where that belongs. Validated to `false`. |
| `metrics_enabled` | `bool` | `true` | Emit per-method CloudWatch metrics for the stage. |
| `cors_allowed_origins` | `list(string)` | required | Origins allowed by the CORS preflight responses on dashboard routes. |
| `minimum_compression_size` | `number` | `1024` | Compress responses larger than this many bytes. `-1` disables compression. |
| `custom_domain_name` | `string` | `null` | Optional custom domain (e.g. `api.example.com`). When set together with `acm_certificate_arn`, a regional domain name with a TLS 1.2 security policy and a base path mapping is created. The execute-api endpoint already negotiates TLS 1.2+ only. |
| `acm_certificate_arn` | `string` | `null` | Regional ACM certificate ARN for `custom_domain_name`. Must be in the same region as the API. |
| `endpoint_type` | `string` | `"REGIONAL"` | API endpoint configuration. `REGIONAL` is required to attach a WAF WebACL directly (D2). Validated to `REGIONAL`, `EDGE` or `PRIVATE`. |
| `manage_account_cloudwatch_role` | `bool` | `true` | Create the account-level API Gateway CloudWatch Logs role and set it in the region's API Gateway account settings. Required for access and execution logging to work at all, but it is a per-account, per-region setting: set `false` if another stack already manages it. |

## Outputs

| Name | Description |
|---|---|
| `rest_api_id` | REST API id. |
| `rest_api_arn` | REST API ARN. |
| `execution_arn` | Execution ARN used in Lambda permission source ARNs. |
| `stage_name` | Deployed stage name, which is also the first path segment. |
| `stage_arn` | Stage ARN. Consumed by the WAF WebACL association. |
| `invoke_url` | Base URL of the stage, e.g. `https://<api-id>.execute-api.<region>.amazonaws.com/v1`. |
| `api_base_url` | Base URL agents and the dashboard should use (the custom domain when configured). |
| `custom_domain_regional_domain_name` | Regional target for the DNS CNAME/ALIAS record, or `null` when no custom domain is configured. |
| `custom_domain_regional_zone_id` | Hosted zone id of the regional endpoint, or `null` when no custom domain is configured. |
| `access_log_group_name` | CloudWatch log group receiving stage access logs. |
| `execution_log_group_name` | CloudWatch log group receiving execution logs. |
| `dashboard_authorizer_id` | Id of the Cognito user pool authorizer. |
| `routes` | Every wired route, as `"<METHOD> <path>"` => integrated function key. |

## Security notes

Against `docs/PLAN.md` §6:

- **Row 1 — TLS everywhere.** The `execute-api` endpoint negotiates TLS 1.2+ only, and the optional custom domain is created with `security_policy = "TLS_1_2"` so the alternative entry point is not weaker than the default one.
- **Row 4 — Cognito.** `COGNITO_USER_POOLS` authorizer on every dashboard route, taking the token from `method.request.header.Authorization`. The MFA half of the requirement is enforced by handler middleware reading the `wl:mfa` claim, not here.
- **Row 6 — WAF plus rate limiting.** `REGIONAL` endpoint type is what makes the direct WebACL association possible at all, and `stage_arn` is the association target the `waf` module consumes. Stage throttling is set to 200 rps / 400 burst via `aws_api_gateway_method_settings` on `*/*`, matching §6 exactly.
- **Row 7 — strict input validation.** Partially: required-header enforcement on device methods happens at the gateway, but body validation is Zod inside the handlers. There are no request models or request validators in this module.
- **Row 10 — audit trail.** Access logs are structured JSON to a CMK-encrypted group and include `sourceIp`, `userAgent`, `cognitoSub`, `wafResponseCode` and `errorMessage` — enough to reconstruct who called what from what address, and whether WAF was involved. This complements the `audit_log` table rather than replacing it.
- **Beyond the checklist.** `data_trace_enabled` is validated to `false` so employee data cannot be logged into CloudWatch by a tfvars change. Response caching is off at both stage and method level, so tenant-scoped responses cannot be served across tenants. `api_key_required = false` everywhere — API keys are not used as a credential, which is correct given they are neither per-device nor unforgeable.

## Gotchas / operational notes

- **`cors_allow_origin` uses `var.cors_allowed_origins[0]` only.** The variable is a list, but every CORS header — preflight and gateway-response alike — is hard-coded to the first element. With more than one dashboard origin (a Vercel preview domain alongside production, say), only the first works from a browser; the others fail preflight. Reflecting the request origin would need a `MOCK` integration mapping or handler-set headers. Also note an empty list fails at plan time on the index.
- **The `routes` table and the `lambda` catalogue must agree.** `invoke_arns[each.value.function]` fails the plan on an unknown key, which is the good direction. The bad direction is a function that exists and is never routed — no error, just an unreachable handler.
- **`api_paths` needs the intermediate segments.** Adding `GET /employees/{id}/notes` requires both the route entry *and* `employees/{id}/notes` in `api_paths`; the parent `employees/{id}` is already there. Miss the path and the plan fails on a missing `local.resource_ids` key.
- **Path depth is capped at five.** `paths_by_depth` iterates `[1,2,3,4,5]` and there are exactly five resource blocks. A six-segment path is silently dropped from `paths_by_depth` and then fails as a missing resource id. Adding a level means adding a `d6` block.
- **Changing `stage_name` changes every public URL.** It is the first path segment, the execution log group name, and the custom domain's base path mapping. Every agent's configured endpoint and the dashboard's API base URL move with it. This is not a rename you do casually on a fleet that is already enrolled.
- **`manage_account_cloudwatch_role` is an account-and-region singleton.** Two WorkLens stacks in the same account and region will overwrite each other's `aws_api_gateway_account` setting on every apply. Set it `false` in all but one.
- **Deleting the account-level role breaks logging silently.** If `manage_account_cloudwatch_role` is flipped to `false` and no other stack provides a role, the stage keeps its `access_log_settings` and simply produces no logs. Nothing errors.
- **The execution log group name embeds the API id.** Recreating the REST API produces a new id, so the old execution log group is orphaned (and billed until retention expires) while a new one is created.
- **A custom domain needs both variables and a DNS record you create yourself.** `local.create_custom_domain` requires `custom_domain_name` *and* `acm_certificate_arn`; setting one has no effect at all, with no warning. The certificate must be regional and in the same region as the API. The module creates the domain and base path mapping but no Route 53 record — point DNS at `custom_domain_regional_domain_name` yourself.
- **WAF association order.** The `waf` module associates its WebACL to `stage_arn`, so the stage exists briefly without WAF protection during a first apply. Do not treat a fresh apply as protected until the WAF module has completed.
- **`POST /aggregation/run` is authorised inside `aggregate-timesheets`.** Because it bypasses `admin-api`, any RBAC change made in the admin handler does not cover this route. Check both when changing who may trigger an aggregation.
- **Device routes carry `authorization = "NONE"` at the gateway.** That is intentional (see design notes), but it means the gateway metrics and access logs show no authorizer decision for device traffic, and a handler that forgets to call the HMAC middleware is an open endpoint with nothing in front of it but WAF. Note also that as `modules/lambda` currently stands, the device handlers other than `enroll` have no `secretsmanager:GetSecretValue` grant on the device root key, which in-handler verification requires.
- **CORS preflight is only created for `auth = "cognito"` paths.** If a device route ever needs to be called from a browser, it gets no `OPTIONS` method.
- **`minimum_compression_size = 1024` applies to responses.** Harmless for JSON, but be aware it interacts with the CSV export path — a streamed export is compressed, which is usually what you want but changes `Content-Length` behaviour for clients that expect it.
