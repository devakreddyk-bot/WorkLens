# Security

This document does two things. The first half is the evidence pass over `docs/PLAN.md` §6 — for
every requirement, where it is implemented and how it was checked. The second half is the parts
of the design that are security decisions rather than checklist items, including the ones that are
deliberately *not* defended and why.

It is written to be read by somebody deciding whether to deploy this, so a claim without evidence
is worse than no claim. Where something is unverified, it says so.

**For how to report a vulnerability, see [`../SECURITY.md`](../SECURITY.md) in the repository root.**

---

## 1. The requirement-by-requirement pass

| # | Requirement | Where | Evidence |
|---|---|---|---|
| 1 | TLS for all traffic; certificate pinning in the agent | `infra/modules/api`, `agent/internal/uploader/pinning.go` | API Gateway minimum TLS 1.2 via security policy. Agent pins the SPKI of all four Amazon roots; 21 assertions in `pinning_test.go` including three real TLS handshakes — reject-unpinned, accept-pinned, and the documented opt-out actually working. The pin constants are checked against the certificates in `testdata/`, so a mistyped pin fails a test rather than the fleet. |
| 2 | Encryption at rest: KMS/AES-256 for RDS and S3 | `infra/modules/observability`, `infra/modules/database`, `infra/modules/storage` | Three customer-managed CMKs with rotation. `storage_encrypted = true` on RDS. Bucket default encryption `aws:kms`, plus a bucket policy that **denies** `s3:PutObject` without the SSE-KMS header and denies `aws:SecureTransport=false`. CloudWatch log groups KMS-encrypted. |
| 3 | Least-privilege IAM per Lambda; secrets in Secrets Manager | `infra/modules/lambda/modules/function` | One role per function, one inline policy set per function. `scripts/check-iam.sh` fails the build on `Resource = "*"` without a justifying `# iam-wildcard-ok:` annotation on the same or preceding line; 13 wildcards exist and all are KMS key policies (where `"*"` means "this key") or Describe actions with no resource-level permissions. |
| 4 | Cognito with MFA required for admin accounts | `infra/modules/auth`, `backend/src/handlers/auth/preTokenGeneration.ts`, `backend/src/middleware/cognitoAuth.ts` | Pool MFA `OPTIONAL` with software tokens; the pre-token trigger reports whether a factor is configured as `wl:mfa`; the API refuses admin-scoped routes without it. Deviation D7 explains why pool-wide `REQUIRED` was the wrong instrument. Enforced at two levels — see §2.2. |
| 5 | `org_id` scoping enforced on every query | `backend/src/repositories/**` | Every repository function takes `orgId` first, from the verified token. Audited by grepping every `from <tenant table>` for an `org_id` predicate; the single exception is the enrolment-token lookup, where the org is what the lookup *returns*. |
| 6 | Database in a private subnet; WAF + rate limiting | `infra/modules/network`, `infra/modules/database`, `infra/modules/waf` | RDS in two private subnets, `publicly_accessible = false`, security group ingress only from the Lambda SG on 5432. WAF WebACL on the REST API stage: AWS managed common + known-bad-inputs, a rate-based rule at 2 000 per 5 minutes per IP, and a tighter 100 on the enrolment path. Stage throttling 200 rps / 400 burst. Per-device application quota on top. |
| 7 | Strict input validation; parameterised queries only | `backend/src/schemas/**`, `backend/src/repositories/**` | Zod at the boundary of every handler, `.strict()` so unknown keys are rejected. All SQL uses positional parameters; verified by grepping for `${` inside a `text:` template across every repository and handler. An eslint rule additionally bans template literals with interpolation in that position. |
| 8 | `.gitignore` covers keys, env, artefacts, SQLite, TF state | `.gitignore` | Verified with `git check-ignore` over 39 paths, confirming `*.tfstate*`, `*.tfvars`, `.env`, `*.db*`, `*.pem`, `credentials.json` and `backend/artifacts/` are ignored while `.terraform.lock.hcl`, `*.tfvars.example` and `.env.example` stay tracked. gitleaks runs in CI over full history as the backstop. One deliberate exception: `backend/assets/rds-ca-global-bundle.pem` is force-included — see §3.4. |
| 9 | `.env.example` for every service; real values never in the repo | `backend/.env.example`, `dashboard/.env.example`, `agent/.env.example`, `infra/terraform.tfvars.example` | Every variable documented with what it is and where to get it. `make env-backend` and `make env-dashboard` generate the real files from Terraform outputs. |
| 10 | CloudTrail enabled + application-level audit log | `infra/modules/observability`, `backend/src/middleware/audit.ts` | Multi-region CloudTrail to a dedicated bucket with a lifecycle policy. `audit_log` written on every read of employee data, every configuration change, every export and every device revocation. `worklens_app` has `INSERT`/`SELECT` and **no `UPDATE` or `DELETE`** — verified by attempting both against a live database. |
| 11 | Configurable data retention + working hard-delete path | `backend/src/handlers/jobs/retentionSweeper.ts`, `admin.ts` | Per-organisation windows in `monitoring_config`; nightly sweeper deletes rows and S3 objects past them, bounded per run. Erasure requests perform a genuine hard delete with the counts recorded. S3 lifecycle rules act as a second line. Both paths delete the object before the row that points at it — see §2.4. |

### Beyond the checklist

Measures added because the threat was real, not because a list asked for them:

- S3 Block Public Access at bucket **and** account level.
- API Gateway execution and access logs to KMS-encrypted groups, with `data_trace_enabled`
  validated so it can only ever be `false` — request bodies contain window titles, and tracing
  would copy personal data into CloudWatch under a different retention policy than the database.
- `reserved_concurrent_executions` on ingest. A database protection, not a cost control: each warm
  container holds a Postgres connection and `db.t4g.micro` allows about 85, so an unbounded retry
  storm would exhaust connections and take the dashboard down with it.
- `deletion_protection` on RDS, 7-day automated backups, point-in-time recovery.
- Secret redaction in the agent's logger and in the backend's, both tested against a known secret
  string across nested structs, maps, slices and wrapped errors.
- VPC flow logs, so "did anything talk to the database that should not have" is answerable after
  the fact.

---

## 2. The decisions worth understanding

### 2.1 Device credentials are derived, not stored

HMAC verification needs the device secret in plaintext at verify time, so hashing it — the right
answer for a password — is unavailable. Rather than store recoverable secrets, the secret is
derived on demand:

```
device_secret = base64url( HMAC-SHA256( root_key[v], "v<v>:<org_id>:<device_id>" ) )
```

The `devices` table stores only `key_version`. **A database dump yields no working device
credential.** Rotation is additive: publish `root_key` v2 and devices move to it as they re-enrol.
Revocation is a `revoked_at` write, checked on every request, so it takes effect on the next call
rather than after a credential TTL.

The version is inside the HMAC message, not merely used to select the key. If it were only a
selector, the same root key published under two versions would derive the same secret; binding it
in keeps each version's output domain distinct.

### 2.2 Admin MFA is enforced at two levels, and needs both

The route-level gate refuses an `owner` or `manager` on an admin-scoped route without `wl:mfa`.
That alone is insufficient, and the gap is easy to miss: an employee's self-view is deliberately
*not* admin-scoped, because gating it would force TOTP on somebody who only wants to see their own
timesheet. So the per-employee routes are reachable without a factor — and without a second check
an admin with no factor could read the whole team through them.

`assertAdminMfaForSubject` re-applies the gate once the subject is known. Both levels are covered
by `test/middleware/authorizationProperties.test.ts`, which was written independently of the
middleware's own suite so it could not inherit its assumptions.

`/v1/me` is the one route left ungated, deliberately: without it the shell that renders the
enrolment page could not load either.

### 2.3 RBAC is a query rewrite, and a cross-employee request is refused

`resolveEmployeeScope` decides whose rows a request may touch and returns that as data, which every
repository function takes as an argument. An `employee` caller's scope is always the `wl:employee`
claim.

A request naming a *different* employee is **refused**, not quietly narrowed to self. Narrowing
would make the request appear to succeed while returning the wrong person's data shape, which is a
worse failure than a 403.

### 2.4 Deletion order: objects before rows

Both the retention sweeper and the erasure path delete the S3 object before the database row that
points at it. Reversed, a crash in between leaves images in the bucket with nothing referring to
them — unreachable through the application, invisible to any retention report, and removable only
by someone reconciling the bucket by hand.

The opposite leak is benign: a row pointing at a missing object is deleted on the next run, and in
the meantime a presign simply fails.

The sweeper also never deletes a row whose object survived. `DeleteObjects` reports per-key errors,
and only the keys that actually went are used to build the row delete.

### 2.5 Request signing, and why not a bearer token

A bearer token is replayable: capture one request and it can be resent until expiry, and shortening
expiry forces a refresh dance into an agent that is frequently offline. Each request is instead
signed over

```
METHOD \n PATH \n TIMESTAMP \n NONCE \n hex(sha256(BODY))
```

Every element defends something specific. Method and path stop a signature captured from one
endpoint being replayed against another — without them a signed `GET /v1/device/config` could be
resent as `POST /v1/device/events`, since both have an empty body. The timestamp bounds replay to
±300 s. The nonce closes that window. The body hash makes the payload tamper-evident.

Nonces are claimed **last**, and only for an otherwise-valid request. Claiming earlier would let
anyone reachable burn a device's nonces with unsigned garbage, and would make a legitimate agent's
retry collide with its own nonce. The claim is the insert itself, not a select-then-insert, because
the latter has a race window two concurrent replays both pass through.

`contracts/signature-vectors.json` pins the agreement between the Go signer and the TypeScript
verifier, tested from both languages. A divergence would present as "signature mismatch" on every
request from every device with no indication which side was wrong.

### 2.6 Certificate pinning targets a CA, not the leaf

Pinning the leaf would fail fleet-wide, simultaneously, on whichever day ACM rotated — and would
look like a backend outage rather than an expiry. All four Amazon roots are pinned, including the
ECDSA ones the endpoint does not use today, so a certificate-type change cannot take the fleet
offline.

This narrows trust from every CA in the system store to Amazon's four. That is the threat being
addressed: a corporate TLS-inspection proxy, or a coerced CA, presenting a valid certificate for
the API's hostname. It does **not** defend against AWS, which is not a threat this design tries to
address.

Pinning is additional, never a replacement. `InsecureSkipVerify` is never set, and a test proves an
untrusted certificate is still rejected even when its key is pinned.

`WORKLENS_TLS_PINNING=off` exists for a deployment behind a mandatory inspection proxy, where the
alternative is an agent that does not work. It logs a warning on **every** startup, because a
silent downgrade would be worse than no pinning.

#### Pin rollover

When AWS retires a root, or a deployment moves behind a proxy:

1. Obtain the new authority's SPKI hash:
   ```bash
   openssl x509 -in NewRootCA.pem -pubkey -noout \
     | openssl pkey -pubin -outform der \
     | openssl dgst -sha256 -binary | base64
   ```
2. **Add** it to `tls_pins` in the agent's `config.json`, or to `WORKLENS_TLS_PINS`, alongside the
   existing pins. Verification succeeds if *any* certificate in the chain matches *any* pin, so
   adding is safe and removing is what breaks a fleet.
3. Roll that configuration out and confirm with `worklens-agentctl doctor`, which performs a real
   handshake against the configured pins.
4. Only once every device reports healthy, retire the old pin.

### 2.7 The `# iam-wildcard-ok:` convention

`scripts/check-iam.sh` is a build gate, so contributors will meet it. An IAM `Resource = "*"` fails
the build unless the line — or the line immediately above it — carries `# iam-wildcard-ok:`
followed by a reason. An annotation with no reason after the colon counts as no annotation.

The wildcards that legitimately need it fall into two groups: a KMS key policy, where `"*"` resolves
to the single key the policy is attached to and no narrower form exists; and actions with no
resource-level permissions at all, such as `ec2:Describe*` for a VPC-attached Lambda and
`logs:DescribeLogGroups`.

### 2.8 Privacy is enforced at four layers, and each fails differently

The guarantee that idle time carries no attribution — so idle minutes cannot reveal what was on
screen — is enforced in four places:

1. The agent's sampler does not ask the OS which window has focus on an idle tick.
2. `internal/privacy` strips attribution from any idle sample reaching it.
3. `internal/store` refuses to buffer an idle event carrying attribution.
4. `activity_events_idle_no_attribution_chk` rejects the batch.

This is not redundancy for its own sake. Each layer fails differently, and the database is the only
one an application bug cannot route around. **Do not remove one because the other three exist.**

`scripts/check-privacy.sh` additionally fails the build on any reference to a forbidden capture API
— `SetWindowsHookEx`, `GetAsyncKeyState`, `OpenClipboard`, audio and camera APIs — in any `.go`,
`.ts`, `.tsx`, `.js`, `.sql` or `.tf` file, including test fixtures. It has fired twice during
development, both times on a test fixture, which is the argument for scanning them.

### 2.9 Tokens never reach client JavaScript

The dashboard completes the OAuth flow server-side and holds tokens in `httpOnly` cookies. The
common alternative keeps them in `localStorage` and calls the API from the browser, where any script
that runs on the page can read a credential good for an hour of access to every employee's
timesheet and screenshots.

PKCE is used even though the flow is server-side, because the app client has no secret — a secret in
a hosting provider's environment variable is readable by anyone with project access, and PKCE gives
the same protection with the verifier never leaving the server's cookie.

Screenshot view URLs live 300 seconds, deliberately shorter than upload URLs: an upload URL is
consumed immediately by the agent, whereas this one hands a human read access to an image of
somebody's screen, and a longer window is a longer period in which a forwarded link still works.

---

## 3. Operational notes

### 3.1 The database is not reachable from a laptop

RDS has no public access. Migrations reach the deployed database only through the in-VPC
`db-migrate` Lambda:

```bash
aws lambda invoke --function-name worklens-prod-db-migrate --payload '{}' /dev/stdout
```

The alternatives were a bastion host — a permanently reachable box holding database access — or a
public database. A short-lived in-VPC function is neither.

### 3.2 Roles

Migrations run as the RDS master user, because `0003_app_role.sql` grants `rds_iam` and only
`rds_superuser` can. The application connects as `worklens_app`, which has DML rights only: it
cannot create, alter or drop anything, cannot read the migration ledger, and cannot `UPDATE` or
`DELETE` the audit log. Verified by attempting each.

### 3.3 There is no NAT gateway

Egress from the private subnets is a free S3 gateway endpoint plus interface endpoints for Secrets
Manager and Cognito. Database authentication is RDS IAM, whose token is signed locally with no
network call.

The security consequence is worth stating: an in-VPC function has no route to the internet at all.
A new AWS API call from one will hang rather than fail fast, and adding a service means adding an
endpoint — which is friction, and the friction is the point.

### 3.4 One PEM is committed on purpose

`backend/assets/rds-ca-global-bundle.pem` is force-included past `.gitignore`'s `*.pem` rule. It is
AWS's published RDS trust store, not a secret, and it must ship inside every Lambda package: the
functions verify the database certificate with `verify-full` and have no route to fetch it at run
time. Committing it also keeps the build reproducible offline and in CI.

`src/shared/db.ts` **fails closed** if it cannot find the bundle. Silently downgrading to an
unverified connection is exactly what `verify-full` was configured to prevent.

---

## 4. What is not defended, and what is unverified

Stated plainly, because a security document that only lists strengths is not useful.

**Not defended:**

- **AWS itself.** Pinning to Amazon's roots narrows trust to AWS; it does not exclude it.
- **A compromised laptop.** An attacker with code execution as the employee can read
  `credentials.json` and submit activity as that device until it is revoked. The mitigations are
  that the file is mode `0600` in the user's own profile, the secret is not stored server-side, and
  revocation is immediate.
- **A malicious owner.** Somebody with the `owner` role can enable screenshots, widen retention and
  read everything. That is the role's purpose. What the design provides instead is accountability:
  every access is in `audit_log`, every employee can see their own record, and configuration changes
  are recorded with who made them.
- **Traffic analysis.** The volume and timing of uploads reveal roughly when a device is active,
  independent of content.

**Unverified:**

- **Nothing has been deployed.** Every claim above is verified against the code, the schema against
  a live PostgreSQL 16, and the Terraform against `validate` — but no AWS account has run this. The
  IAM policies have not been exercised, the WAF rules have not seen traffic, and the presigned-upload
  path has not been end-to-end tested against real S3.
- **The Windows agent has not run on Windows.** It cross-compiles and `go vet` passes for
  `windows/amd64`, and every package with testable logic is tested — but the Win32 syscall layer has
  not executed. Its correctness rests on cross-compilation and review.
- **No penetration test or external review** has been performed.
- **The regex screen in the aggregation is a heuristic.** It catches the common catastrophic
  constructions and lets exotic ones through; deciding this in general is not tractable. The real
  defence is the server refusing to store such a pattern.

### 4.1 Two dependency advisories are present and, in this configuration, unreachable

`npm audit` reports three high-severity advisories in `dashboard/`, all transitive through `next`
and all unfixed on the 15.x line — the remedy npm offers is `next@16`, a major upgrade. The
dashboard is on 15.5.23, the newest 15.x. Rather than either ignoring this or taking a major bump
during a hardening pass, here is why neither is reachable as the dashboard is built, and what would
change that:

| Advisory | Why it is not reachable here | What would make it reachable |
|---|---|---|
| `sharp` < 0.35.0 — inherited libvips CVEs (image decoding) | `next/image` is not used anywhere, and `next.config.ts` sets `images: { unoptimized: true }`. Screenshots go from the browser to S3 through a presigned URL and are rendered by a plain `<img>`; no image of anybody's screen passes through the Next.js server, so `sharp` never decodes one. | Adopting `next/image` for screenshots, or removing `unoptimized`. Then a compromised agent's uploaded image would reach libvips. |
| `postcss` <= 8.5.22 — XSS via unescaped `</style>`, and arbitrary `.map` file disclosure via `sourceMappingURL` | PostCSS runs at build time over CSS in this repository, authored by whoever builds it. No user-supplied or runtime CSS is processed. | Processing CSS from any source other than the repository — a themable stylesheet, tenant branding, anything uploaded. |

Worth being precise about what this is and is not. It is not a statement that the advisories are
harmless: both are real, and the `sharp` one would matter a great deal in a product that resized
uploaded images. It is a statement that the specific code paths they affect are not present. Note
also that the configuration doing the work was chosen for a different reason — `unoptimized: true`
is there so that images of people's screens are not proxied through the application server — which
means it could be reverted by somebody who had no idea it was also load-bearing for this.

So: `next@16` is the fix, it belongs in its own change with the build verified against it, and until
then a reviewer reading `npm audit` should find this table rather than concluding nobody looked.
Re-check with `npm audit` in `dashboard/` after any `next` upgrade.

---

## 5. Before deploying this

- [ ] Set `alarm_email` in `terraform.tfvars`. Without it alarms publish to a topic with no
      subscriber, and a failed nightly aggregation silently produces no timesheets.
- [ ] Remove `http://localhost:3000` from `dashboard_origins`.
- [ ] Fill the contact placeholders in `CODE_OF_CONDUCT.md` and the root `SECURITY.md`.
- [ ] Confirm `api_data_trace_enabled` is `false`.
- [ ] Enrol a second factor on every `owner` and `manager` account.
- [ ] Read `docs/RESPONSIBLE_USE.md` and complete the legal sign-off it describes. **This is not a
      technical step and the software cannot do it for you.**
- [ ] Run `worklens-agentctl doctor` on a real device and confirm every check passes.
