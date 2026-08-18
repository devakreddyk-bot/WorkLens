# `network`

Owns the VPC that the data plane lives in: one VPC, a public and a private `/24` per availability zone, an internet gateway attached to the public route tables, three security groups (in-VPC Lambda, RDS, interface endpoints) wired to each other by reference rather than by CIDR, the S3 gateway endpoint plus the Secrets Manager and (optional) Cognito interface endpoints that stand in for internet egress, and optional VPC flow logs to a KMS-encrypted CloudWatch log group. It does not create a NAT gateway, and the private route tables have no default route at all.

## Design notes

**There is no NAT gateway, and the private subnets have no `0.0.0.0/0` route.** This is deviation D6 in `docs/PLAN.md`. Putting the database in a private subnet forces the data-plane Lambdas into the VPC, and the naive consequence is a NAT gateway (~$33/month plus data processing) whose only job is letting Lambda call AWS APIs. The module removes the need for it three ways: RDS IAM authentication means the database auth token is computed locally by the SDK with no network call; the S3 gateway endpoint is free and carries every screenshot `PutObject`/`DeleteObjects`; and a single Secrets Manager interface endpoint (~$7.30/month per ENI) carries the device root key fetch. What this buys in cost, it costs in surprise: any *new* AWS service a Lambda in these subnets wants to call will not work until an endpoint for it is added here, and it will fail by timing out rather than by refusing the connection.

**The Cognito interface endpoint exists because of D7, not for convenience.** Admin MFA is enforced server-side, which means the pre-token-generation Lambda and the admin API call `cognito-idp` (`AdminGetUser`, user management for `POST`/`PATCH /v1/users`) from inside the VPC. With no NAT gateway those calls need a `cognito-idp` endpoint or they hang. The variable exists so a deployer who creates dashboard users out of band with the console or CLI can drop the ENI cost.

**Egress is enumerated, not blanket.** The Lambda security group is created with no rules at all, then given exactly three egress rules: TCP 5432 to the RDS security group by reference, TCP 443 to the endpoint security group by reference, and TCP 443 to the S3 gateway endpoint's *prefix list* — which is the only way to scope egress to a gateway endpoint, since gateway endpoints have no ENI and no security group of their own. The RDS security group is given an ingress rule from the Lambda SG and deliberately no egress rule whatsoever; the code says why, and it is correct: security groups are stateful, so replies to established inbound connections flow regardless, and a database in this design never originates a connection.

**Interface endpoint ENIs default to one subnet.** `interface_endpoint_subnet_count` defaults to 1 and is clamped by `min()` against the AZ count, because each ENI is billed hourly. Set it to 2 if you would rather not have a single-AZ dependency for the Secrets Manager fetch on the ingest path.

**Public subnets are created but nothing uses them.** They exist with an IGW route and `map_public_ip_on_launch = false`, described in the outputs as reserved for a future bastion. They cost nothing while empty. `map_public_ip_on_launch` is false on public and private subnets alike so nothing in this deployment gets a public address implicitly.

**AZ selection filters on `opt-in-not-required`.** The `aws_availability_zones` data source excludes Local Zones and opt-in regions' zones, so a plan does not pick a zone the account cannot actually launch into.

**Security groups use `create_before_destroy`.** Renaming a security group would otherwise deadlock: AWS refuses to delete a group with dependent references, so the replacement must exist before the old one is removed.

**Flow logs use a 600-second aggregation interval** and capture `ALL` traffic (accepts and rejects), which is the cheaper of the two intervals and adequate for after-the-fact "did anything try to leave" questions rather than live troubleshooting.

## Inputs

| Name | Type | Default | Description |
|---|---|---|---|
| `name_prefix` | `string` | required | Prefix applied to the name of every resource in this module (e.g. `worklens-prod`). |
| `tags` | `map(string)` | required | Common tag map applied to every taggable resource. |
| `vpc_cidr` | `string` | `"10.30.0.0/16"` | IPv4 CIDR block for the VPC. Must be large enough for 2 public + 2 private `/24` subnets. |
| `availability_zone_count` | `number` | `2` | Number of availability zones to spread subnets across. The plan requires 2. Validated to 2 or 3. |
| `interface_endpoint_subnet_count` | `number` | `1` | How many private subnets receive an ENI for each interface VPC endpoint. Each ENI costs ~$7.30/month; 1 matches the cost model in `docs/PLAN.md` §10, 2 removes the single-AZ dependency at roughly double the endpoint cost. Validated to be at least 1. |
| `enable_cognito_vpc_endpoint` | `bool` | `true` | Create a `cognito-idp` interface endpoint. Required for the in-VPC admin-api Lambda to manage dashboard users because there is no NAT gateway (D6). Disable only if dashboard users are created out of band. |
| `flow_log_retention_days` | `number` | `30` | CloudWatch Logs retention (days) for VPC flow logs. |
| `logs_kms_key_arn` | `string` | required | KMS CMK ARN used to encrypt the VPC flow log group. |
| `enable_flow_logs` | `bool` | `true` | Emit VPC flow logs (REJECT + ACCEPT) to a KMS-encrypted CloudWatch log group. |
| `database_port` | `number` | `5432` | TCP port the database listens on; used to scope the Lambda→RDS security group rules. |

## Outputs

| Name | Description |
|---|---|
| `vpc_id` | VPC id. |
| `vpc_cidr` | VPC IPv4 CIDR block. |
| `private_subnet_ids` | Private subnet ids (no default route). Lambda and RDS live here. |
| `public_subnet_ids` | Public subnet ids (IGW route). Unused by default; reserved for a future bastion. |
| `availability_zones` | Availability zones the subnets are spread across. |
| `lambda_security_group_id` | Security group for in-VPC Lambda functions. |
| `rds_security_group_id` | Security group for the RDS instance. |
| `vpc_endpoint_security_group_id` | Security group attached to the interface VPC endpoints. |
| `s3_prefix_list_id` | Prefix list id of the S3 gateway endpoint. |
| `s3_vpc_endpoint_id` | S3 gateway endpoint id. |
| `secretsmanager_vpc_endpoint_id` | Secrets Manager interface endpoint id. |
| `cognito_vpc_endpoint_id` | Cognito IDP interface endpoint id, or `null` when disabled. |
| `flow_log_group_name` | CloudWatch log group receiving VPC flow logs, or `null` when disabled. |

## Security notes

Against `docs/PLAN.md` §6:

- **Row 6 — private-subnet database.** The private route tables are created with no default route, so there is no path from those subnets to the internet in either direction. `aws_vpc_security_group_ingress_rule.rds_from_lambda` is the only ingress rule on the RDS security group: TCP on `database_port`, sourced by security-group reference from the Lambda SG rather than by CIDR, so widening the VPC CIDR cannot widen database access. The WAF and rate-limiting half of that row is the `waf` module's.
- **Row 2 — encryption at rest.** The flow log group is created with `kms_key_id = var.logs_kms_key_arn`, so flow records land in a CMK-encrypted log group rather than a default-encrypted one.
- **Beyond the checklist.** Flow logs on `ALL` traffic give a record of connection attempts that were rejected, which is the evidence you want if the question is ever whether something in the private subnets tried to reach out.

## Gotchas / operational notes

- **`logs_kms_key_arn` is required even when `enable_flow_logs = false`.** There is no conditional on the variable, only on the resources that use it. The root stack always has a key to pass, so this only bites someone using the module standalone.
- **A new AWS API call from an in-VPC Lambda needs a new endpoint here.** Because there is no default route, an SDK call to a service with no endpoint in this module does not get a fast failure — it hangs until the Lambda timeout. If a handler starts calling SNS, SES, SQS, STS or anything else, add the endpoint in this module before debugging the handler.
- **`interface_endpoint_subnet_count = 1` puts a single-AZ dependency on the ingest path.** The Secrets Manager fetch for the device root key happens once per Lambda container; if the AZ holding that one ENI is impaired, new containers cannot derive device secrets. Acceptable at one-org scale, deliberately chosen for cost, worth revisiting before anyone calls this highly available.
- **Changing `vpc_cidr` replaces the VPC**, and therefore the subnets, and therefore the RDS instance and every Lambda ENI. It is not an in-place edit.
- **The subnet layout is positional.** Public subnets take `cidrsubnet(vpc_cidr, 8, 0..n-1)` and private take `8, 10..10+n-1`. Raising `availability_zone_count` from 2 to 3 appends a third subnet in each tier without disturbing the first two; lowering it destroys the highest-indexed subnets. `vpc_cidr` must be a `/16` or shorter for the `newbits = 8` split to be valid.
- **`database_port` must match the `database` module's `database_port`.** They are separate variables set from the same literal in the root stack; changed in one place only, the security group and the listener disagree and every connection is refused.
- **ENI cleanup on destroy is slow.** Deleting a VPC that has hosted in-VPC Lambdas waits on Lambda's own ENI reaping, which can take several minutes. A `terraform destroy` that appears stuck on the subnets or security groups is usually this.
