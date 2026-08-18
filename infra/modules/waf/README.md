# `waf`

Owns the regional WAFv2 WebACL in front of the API: two rate-based rules (one fleet-wide per-IP, one much tighter one scoped to the enrollment route), the AWS managed common and known-bad-inputs rule groups, the association to the API Gateway stage, and — when enabled — a `aws-waf-logs-` prefixed KMS-encrypted CloudWatch log group with the resource policy log delivery needs and a logging configuration that redacts credential headers and keeps only interesting requests.

## Design notes

**Rule priority is a cost decision as much as a security one.** The rate-based rules sit at priorities 1 and 2, the managed groups at 10 and 11, and the header comment says why: managed rule group evaluation is what WAF bills per request, so a flood should be dropped by the rate rule before it is ever inspected. Under attack this is the difference between paying to rate-limit and paying to deep-inspect every request in a flood. The gaps in the numbering (1, 2, 10, 11) leave room to insert rules without renumbering.

**Rate-limit blocks return 429, not the WAF default 403.** Both rate rules set `custom_response.response_code = 429`. That matters because the agent's uploader honours 429 with exponential backoff and `Retry-After`; a 403 would read as an authentication failure, and a well-behaved agent would keep retrying at full rate while an operator chased a credential problem that did not exist.

**Enrollment gets its own rule because it is the only unauthenticated route.** The second rate rule uses a `scope_down_statement` — a `byte_match_statement` with `ENDS_WITH` on `/device/enroll`, lowercased first — so the tighter limit applies to that path only, while the general limit still covers everything. `LOWERCASE` transformation is there so path-casing tricks do not slip past the match. This is the WAF layer of the three-part protection the plan describes for enrollment: single-use hashed tokens, this rule, and stage throttling.

**`SizeRestrictions_BODY` is excluded by default, and the reason is structural.** The managed common rule set flags request bodies over 8 KB, and an ingest batch of up to 500 activity events legitimately exceeds that. Leaving the rule in block mode would break normal ingest for any device that has been offline for a while — exactly the case the buffering design is built around. It is set to `count` rather than removed, so the traffic is still visible in the metrics.

**Excluded rules use `rule_action_override` with `count {}`,** which is the current mechanism (the older `excluded_rule` block is deprecated). Overriding to `count` rather than dropping the rule keeps the CloudWatch metric and sampled requests, so you can see what *would* have been blocked.

**`override_action` is built with dynamic blocks** because `count {}` and `none {}` are mutually exclusive empty blocks and Terraform has no ternary for that shape. `common_rule_set_count_only` flips the whole common rule set to count mode in one variable — the intended use is a first deployment where you want to confirm no legitimate agent traffic is caught before enforcing.

**The log group name is not a stylistic choice.** WAF refuses any CloudWatch destination whose name does not begin with `aws-waf-logs-`, which the code comments. Same class of constraint as the API module's execution log group.

**Credential headers are redacted at the logging configuration.** `authorization`, `x-wl-signature` and `cookie` are listed in `redacted_fields`. WAF logs include matched headers, so without this a blocked request would deposit a device's HMAC signature or a user's bearer token into CloudWatch — turning the security log into a credential store. Note that redaction affects the log only; the rules still evaluate the real values.

**Logging defaults to blocked-and-counted requests only.** `log_only_blocked_and_counted` builds a `logging_filter` with `default_behavior = "DROP"` and a `KEEP` filter matching `BLOCK` or `COUNT` actions, so CloudWatch cost scales with attack traffic rather than with the fleet's normal upload volume. The complete request record for allowed traffic lives in the API module's access log group instead, which is cheaper per record and already structured.

**Log delivery is granted through a log-group resource policy, not a role.** WAF delivers via `delivery.logs.amazonaws.com`, and the policy is conditioned on both `aws:SourceAccount` and an `ArnLike` `aws:SourceArn` for this account's log groups in this region — the standard confused-deputy guard. The logging configuration `depends_on` the resource policy so delivery is authorised before it is switched on.

**`web_acl_capacity` is exported deliberately.** WAF bills per 500 WCUs above the included allocation, and the two managed rule groups are the bulk of the consumption. Having the number as an output means a rule addition's cost is visible in the plan rather than discovered on a bill.

## Inputs

| Name | Type | Default | Description |
|---|---|---|---|
| `name_prefix` | `string` | required | Prefix applied to the name of every resource in this module (e.g. `worklens-prod`). |
| `tags` | `map(string)` | required | Common tag map applied to every taggable resource. |
| `api_stage_arn` | `string` | required | ARN of the API Gateway REST API stage the WebACL is associated with. |
| `rate_limit_per_five_minutes` | `number` | `2000` | Requests from a single IP in any 5 minute window before that IP is blocked. Validated to be at least 100. |
| `enroll_rate_limit_per_five_minutes` | `number` | `100` | Tighter rate limit applied only to `/v1/device/enroll`. Enrollment is the one unauthenticated route, so it gets its own much lower ceiling on top of single-use tokens. |
| `common_rule_set_count_only` | `bool` | `false` | Run `AWSManagedRulesCommonRuleSet` in count mode instead of block. Useful for a first deployment while confirming no legitimate agent traffic is caught; flip back to `false`. |
| `common_rule_set_excluded_rules` | `list(string)` | `["SizeRestrictions_BODY"]` | Rules inside `AWSManagedRulesCommonRuleSet` to run in count mode. `SizeRestrictions_BODY` is excluded by default because an ingest batch of 500 events legitimately exceeds the 8 KB body size the managed rule flags. |
| `known_bad_inputs_excluded_rules` | `list(string)` | `[]` | Rules inside `AWSManagedRulesKnownBadInputsRuleSet` to run in count mode. |
| `log_retention_days` | `number` | `30` | CloudWatch Logs retention in days for WAF logs. |
| `log_kms_key_arn` | `string` | required | CMK ARN encrypting the WAF log group. |
| `enable_logging` | `bool` | `true` | Send WebACL request logs to CloudWatch Logs. |
| `log_only_blocked_and_counted` | `bool` | `true` | Log only requests WAF blocked or counted, not every allowed request. Keeps CloudWatch cost proportional to attack traffic rather than to normal agent traffic. |

## Outputs

| Name | Description |
|---|---|
| `web_acl_arn` | ARN of the regional WebACL. |
| `web_acl_id` | Id of the regional WebACL. |
| `web_acl_name` | Name of the regional WebACL. |
| `web_acl_capacity` | WCUs consumed by the WebACL. WAF bills per 500 WCUs above the base allocation. |
| `log_group_name` | CloudWatch log group receiving WAF logs, or `null` when logging is disabled. |

## Security notes

Against `docs/PLAN.md` §6:

- **Row 6 — WAF plus rate limiting.** This module is the WAF half in full: `AWSManagedRulesCommonRuleSet` and `AWSManagedRulesKnownBadInputsRuleSet` are both attached, and the rate-based rule defaults to 2000 requests per 5 minutes per IP — exactly the figure §6 specifies. The association to the stage is what makes D2's REST-API choice pay off. The additional enroll-specific rate rule is beyond what §6 asks for.
- **Row 2 — encryption at rest.** The WAF log group is created with `kms_key_id = var.log_kms_key_arn`.
- **Beyond the checklist.** Redacting `authorization`, `x-wl-signature` and `cookie` from WAF logs keeps device HMAC signatures and dashboard tokens out of CloudWatch. The log-delivery resource policy is conditioned on source account and source ARN. Every rule has `sampled_requests_enabled` and CloudWatch metrics on, so a block is investigable rather than merely counted.

## Gotchas / operational notes

- **`enroll_rate_limit_per_five_minutes` has no validation, but AWS enforces a floor of 100.** The sibling variable validates the floor; this one does not, and its default sits exactly on it. Setting it to 50 passes `terraform plan` and fails at `apply`.
- **`common_rule_set_count_only` defaults to `false`, so a first apply is enforcing.** The variable's own description recommends the opposite for a first deployment. If you are rolling out to a fleet for the first time, set it `true`, watch the counted metrics for a day, then flip it back — a managed rule blocking a legitimate agent request looks to the agent like a persistent upload failure.
- **Per-IP rate limiting aggregates a whole office behind one NAT address.** Every agent in a site shares one source IP as far as WAF is concerned, so the fleet's combined request rate is what counts against `rate_limit_per_five_minutes`, not each device's. The plan's ~1.4 M requests/month for 50 devices averages to a couple of hundred per 5-minute window, so 2000 has real headroom — but a burst of agents draining large offline buffers simultaneously is the scenario that would find the ceiling. Watch the `rate-limit-per-ip` metric after any fleet-wide outage.
- **The association is a separate resource from the WebACL.** Removing this module, or just the association, leaves the API serving traffic with no WAF in front of it and nothing to indicate the change. Similarly, on a first apply the stage exists briefly before the association is created.
- **A blocked request never reaches the access log with a status you can explain.** WAF blocks before API Gateway, so the api module's access log will not show the request at all; `wafResponseCode` in that log only helps for requests WAF allowed. Diagnosing "the agent gets 429 but the API shows nothing" means looking at the WAF log group and the rule metrics.
- **`log_only_blocked_and_counted = true` means WAF logs are not a request audit.** If you need to prove what an allowed request contained, that is the API access log, not this.
- **The CMK must permit CloudWatch Logs to use it.** The WAF log group is CMK-encrypted, so the `logs` key policy in `observability` has to allow the CloudWatch Logs service principal; a key policy change there can break WAF log delivery without any change in this module.
- **Adding rules costs WCUs.** The two managed groups are already a substantial share of the base allocation. Check `web_acl_capacity` after adding a rule; crossing a 500-WCU boundary is a step change in the monthly bill, not a gradual one.
- **`api_stage_arn` must be a stage ARN, not the REST API ARN.** WAF associates to a stage; passing the API ARN fails at apply with a message that does not make the distinction obvious.
- **Rule name changes force replacement of the WebACL rule set** and briefly reset rate-based rule state, so an IP mid-block is released. Harmless, but it means a rename is not a no-op during an active incident.
