# `auth`

Owns dashboard identity: the Cognito user pool, its hosted-UI domain, the three RBAC groups (`owner`, `manager`, `employee`), the public app client the Next.js dashboard uses for authorization-code login, the `lambda:InvokeFunction` permission that lets Cognito call the pre-token-generation trigger, and the two IAM role policies that give the pre-token-generation and admin-api Lambdas their `cognito-idp` permissions. It does not own the Lambdas themselves, or the RBAC decisions — the groups only supply the `cognito:groups` claim that the API middleware reads.

## Design notes

**Pool MFA is `OPTIONAL`, and that is what makes admin MFA enforceable.** This is deviation D7. Cognito's MFA policy is pool-wide: `OFF`, `OPTIONAL` or `REQUIRED`. "MFA required for admin accounts" therefore cannot be expressed as pool configuration without also forcing TOTP enrolment on every employee who logs in purely to see their own timesheet — which is a self-view trust feature, not an administrative one. So the pool is `OPTIONAL` with `software_token_mfa_configuration` enabled, employees may enrol, admins *must*, and the "must" is enforced where enforcement is reliable: the pre-token-generation trigger calls `AdminGetUser`, reads `UserMFASettingList`, and injects a `wl:mfa` claim; the API middleware rejects any admin-scoped route where the caller is in `owner` or `manager` and `wl:mfa !== "on"`. A user can decline TOTP; they cannot decline it and still use an admin route.

**The IAM policies for two Lambda roles live in this module, not in `modules/lambda`.** Both policies need the user pool ARN as their `resources` value, and the pool is created here. Granting them from `modules/lambda` would mean `lambda` depending on `auth` for the ARN while `auth` depends on `lambda` for the trigger ARN — a cycle. The dependency is inverted instead: `auth` takes *role names* as inputs (`pre_token_generation_role_name`, `admin_api_role_name`) and attaches inline policies to roles it did not create. This is also why the root stack passes no user pool id into `modules/lambda`: the pre-token-generation handler reads the pool id off the Cognito event it is invoked with, so nothing has to flow backwards.

**`resources = [pool_arn]` is as narrow as these actions get.** The `cognito-idp:Admin*` actions are authorised at user-pool granularity — there is no per-user resource ARN — so a single pool ARN is the least privilege available, and it satisfies §6's "no `*` in any resource block". The pre-token role gets exactly two read actions; the admin-api role gets the twelve user-management actions it needs and nothing else (no `DeleteUser`, note — accounts are disabled, not deleted).

**The trigger is wired as the V1 `pre_token_generation` trigger,** with the code comment stating that claims are injected into the ID token, which is what the dashboard and the API Gateway `COGNITO_USER_POOLS` authorizer both read.

**No self-signup, ever.** `allow_admin_create_user_only = true`: this is a single-company deployment where an owner creates accounts and hands out temporary passwords, so the entire self-registration surface — and the email-enumeration and abuse problems that come with it — simply does not exist. `prevent_user_existence_errors = "ENABLED"` closes the remaining enumeration channel on the login form.

**The app client is public with a deliberately narrow auth surface.** `generate_secret = false` because a Next.js browser flow cannot keep a secret; the code comment records that PKCE is a property of the authorization request the dashboard sends (`code_challenge`/`S256`) rather than something toggled here, and that Cognito requires it for public clients on the code flow. `explicit_auth_flows` is restricted to `ALLOW_USER_SRP_AUTH` and `ALLOW_REFRESH_TOKEN_AUTH` — notably *not* `ALLOW_USER_PASSWORD_AUTH` or `ALLOW_ADMIN_USER_PASSWORD_AUTH`, so no code path exists that ships a plaintext password to Cognito. `write_attributes = ["email"]` means a signed-in user cannot rewrite their own attributes to something the claims logic reads, and `attributes_require_verification_before_update = ["email"]` means an email change does not take effect until the new address is proven.

**Account recovery is email-only.** One `verified_email` mechanism at priority 1, no SMS, which removes SIM-swap from the recovery path for accounts that can read every employee's activity.

**Group precedence is a typed object, and lower wins.** `owner = 1`, `manager = 5`, `employee = 10`, spaced rather than consecutive so a role can be inserted between two existing ones without renumbering. Cognito orders the `cognito:groups` claim by precedence, so the middleware can take the first entry as the effective role.

**The built-in Cognito email sender is used, with its limit written down.** `COGNITO_DEFAULT` is capped at 50 emails per day. For a one-org dashboard that is invites and password resets only, so the cap is ample; the comment names the escape hatch (switch to SES via `DEVELOPER`) rather than leaving a future operator to discover the cap at the worst moment.

**`advanced_security_mode` defaults to `OFF` on cost grounds** — it is billed per monthly active user beyond the free tier — with the variable description recommending `AUDIT` or `ENFORCED` once past pilot.

## Inputs

| Name | Type | Default | Description |
|---|---|---|---|
| `name_prefix` | `string` | required | Prefix applied to the name of every resource in this module (e.g. `worklens-prod`). |
| `tags` | `map(string)` | required | Common tag map applied to every taggable resource. |
| `domain_prefix` | `string` | required | Hosted UI domain prefix; the login page becomes `https://<domain_prefix>.auth.<region>.amazoncognito.com`. Must be globally unique. |
| `callback_urls` | `list(string)` | required | Allowed OAuth redirect targets after login (the dashboard `/api/auth/callback` route). Validated non-empty. |
| `logout_urls` | `list(string)` | required | Allowed redirect targets after sign-out. Validated non-empty. |
| `password_minimum_length` | `number` | `12` | Minimum dashboard password length. Validated to be at least 12. |
| `temporary_password_validity_days` | `number` | `3` | How long an admin-created temporary password stays usable. |
| `advanced_security_mode` | `string` | `"OFF"` | Cognito threat protection: `OFF`, `AUDIT` or `ENFORCED`. Off by default because it is billed per monthly active user on top of the free tier; `AUDIT` or `ENFORCED` is recommended once the deployment is past pilot. Validated against those three values. |
| `deletion_protection` | `bool` | `true` | Refuse to delete the user pool. Deleting it orphans every dashboard user. |
| `id_token_validity_minutes` | `number` | `60` | ID token lifetime in minutes. |
| `access_token_validity_minutes` | `number` | `60` | Access token lifetime in minutes. |
| `refresh_token_validity_days` | `number` | `30` | Refresh token lifetime in days. |
| `pre_token_generation_lambda_arn` | `string` | required | ARN of the pre-token-generation Lambda that injects the `wl:mfa` claim (D7). |
| `pre_token_generation_lambda_function_name` | `string` | required | Function name of the pre-token-generation Lambda, used for the invoke permission. |
| `pre_token_generation_role_name` | `string` | required | Execution role name of the pre-token-generation Lambda. This module attaches its `cognito-idp:AdminGetUser` policy, because the user pool ARN is created here — doing it in `modules/lambda` would make the two modules mutually dependent. |
| `admin_api_role_name` | `string` | required | Execution role name of `admin-api`, which manages dashboard users in this pool. |
| `group_precedence` | `object({ owner = number, manager = number, employee = number })` | `{ owner = 1, manager = 5, employee = 10 }` | Cognito group precedence values. Lower wins when a user is in several groups. |

## Outputs

| Name | Description |
|---|---|
| `user_pool_id` | Cognito user pool id. |
| `user_pool_arn` | Cognito user pool ARN. Consumed by the API Gateway `COGNITO_USER_POOLS` authorizer. |
| `user_pool_endpoint` | Issuer host of the pool, used for JWT verification. |
| `user_pool_issuer_url` | Full OIDC issuer URL (the `iss` claim of every token). |
| `client_id` | App client id for the dashboard (public client, no secret). |
| `domain` | Hosted UI domain prefix. |
| `hosted_ui_domain` | Fully qualified hosted UI domain. |
| `hosted_ui_login_url` | Ready-to-use hosted UI authorization URL for the dashboard client. |
| `group_names` | Names of the RBAC groups. |

## Security notes

Against `docs/PLAN.md` §6:

- **Row 4 — Cognito with MFA required for admins.** This module supplies the infrastructure half of D7: `mfa_configuration = "OPTIONAL"`, `software_token_mfa_configuration.enabled = true`, the `lambda_config.pre_token_generation` wiring, the `lambda:InvokeFunction` permission scoped by `source_arn` to this pool, and the `cognito-idp:AdminGetUser`/`AdminListGroupsForUser` grant the trigger needs to read `UserMFASettingList`. The rejection of admin routes without `wl:mfa = on` is backend middleware, not Terraform.
- **Row 3 — least-privilege IAM.** Both inline policies name the pool ARN as their only resource; neither uses `*` in a resource block, neither includes `iam:PassRole`. The admin-api grant deliberately excludes `AdminDeleteUser`.
- **Row 5 — `org_id` scoping.** Supported rather than enforced here: the groups are the source of the `cognito:groups` claim, and the pre-token trigger is where org/role/employee claims come from, so the API can take scope from a verified token instead of user input.
- **Beyond the checklist.** Password policy at 12 characters with all four character classes; `allow_admin_create_user_only` (no self-signup); no password-based auth flows enabled; `prevent_user_existence_errors`; `enable_token_revocation` so a compromised refresh token can be killed; email-only recovery; `auth_session_validity = 3` minutes on the challenge session; and `deletion_protection` defaulting to `ACTIVE`.

## Gotchas / operational notes

- **The pre-token-generation Lambda is on the critical path of every single login.** If it errors or times out, Cognito fails token generation and *nobody* can sign in — employees included, not just admins. It is also in the VPC (it reads org, role and employee identity out of Postgres), which is precisely why the `network` module creates a `cognito-idp` interface endpoint: with no NAT gateway, its `AdminGetUser` call has no other route out. Breaking that endpoint, that security group, or that function breaks dashboard login for everyone. Treat changes to it as production-impacting.
- **`deletion_protection` shares a variable with the database in the root stack.** `infra/main.tf` passes `var.db_deletion_protection` to both `module.database.deletion_protection` and `module.auth.deletion_protection`. Turning it off to tear down the database also unprotects the user pool in the same apply. Deleting the pool is not recoverable — there is no user export, and every dashboard user, group membership and TOTP registration goes with it.
- **The V1 trigger customises ID-token claims.** The module comment states this explicitly. `backend/functions.json` describes the same function as injecting claims into *access* tokens; access-token claim customisation needs the V2 trigger (`pre_token_generation_config` with `V2_0`), which is not what is configured here. Reconcile the two before writing middleware that reads `wl:mfa` off an access token.
- **`callback_urls` are exact URIs, not origins.** The root stack composes them as `<origin>/api/auth/callback` and logout URLs as `<origin>/login`. Adding a dashboard origin (a Vercel preview domain, say) means re-applying so Cognito learns the new redirect URI; Cognito rejects anything not on the list, with an error that does not name the problem clearly.
- **`hosted_ui_login_url` hard-codes `callback_urls[0]`.** With more than one dashboard origin, that output points at whichever origin happens to be first in `var.dashboard_origins`. Useful for a smoke test, not something to paste into documentation.
- **`domain_prefix` must be globally unique and changing it is disruptive.** The root stack derives it from the same `random_id.suffix` as the bucket names to keep a first apply from colliding with a name someone else has taken. Changing it later replaces the domain, changes the hosted-UI hostname, and invalidates every bookmark and every dashboard environment variable pointing at the old one.
- **The 50-emails-per-day cap on `COGNITO_DEFAULT` is real.** Bulk-onboarding more than ~50 users in a day silently fails to deliver invites. Switch `email_sending_account` to `DEVELOPER` with a verified SES identity before a large rollout.
- **Nothing here puts users into groups.** Group membership is created by the admin-api Lambda at runtime. A freshly applied stack has three empty groups; the first owner has to be created and added to `owner` out of band.
- **Cognito token-validity bounds are not validated by these variables.** Cognito requires ID and access token lifetimes between 5 minutes and 1 day and refresh tokens between 60 minutes and 10 years; values outside that range fail at apply time rather than at plan time. Also note that shortening `refresh_token_validity_days` does not shorten already-issued refresh tokens.
- **`advanced_security_mode = "OFF"` is the default and is a weaker posture than the module recommends for production.** Set it to `AUDIT` at minimum once you are past pilot; it is a per-MAU cost, not a re-architecture.
