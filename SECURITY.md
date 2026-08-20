# Security Policy

WorkLens handles employees' personal data. A vulnerability here is not an
abstract risk — it is somebody's window titles, screenshots and working hours.
Reports are taken seriously and are welcome.

---

## Reporting a vulnerability

**Do not open a public issue, discussion, or pull request for a security
vulnerability.** Do not describe it on social media before it is fixed.

Report it privately, by either route:

1. **GitHub private security advisory** (preferred). Go to the repository's
   **Security → Advisories → Report a vulnerability**. This creates a private
   thread visible only to you and the maintainers, and it lets us issue a
   patched release and a CVE from the same place.
2. **Email** — devkreddyk@gmail.com.

> A note on which route to pick. The advisory route is preferred and not merely
> listed first: it gives us a private thread, a patched release and a CVE from
> one place, and it does not put the details of an unpatched vulnerability into
> anybody's mailbox. Use the email if you would rather not have a GitHub
> account, or if the advisory form is not working for you.
>
> There is no PGP key yet. If you have something whose *contents* need
> encrypting rather than just a private channel, open an advisory instead —
> that thread is already private — or say so by email and we will arrange a key
> before you send anything sensitive.

### What to include

The more of this you can provide, the faster the fix:

- The component: `agent`, `backend`, `dashboard`, `infra`, or the CI pipeline.
- The version, tag, or commit SHA you tested.
- What an attacker can do, and what they need first (network position,
  a valid device credential, an authenticated employee session, AWS access).
- Reproduction steps or a proof of concept.
- Your assessment of impact, and any suggested fix.

**Redact real data.** If your proof of concept involves captured activity, a
device secret, an enrolment token or a Cognito token, replace it with a
placeholder and say what shape the real value had. Do not send us other
people's personal data.

### Safe harbour

We will not pursue or support legal action against anyone who reports in good
faith, stays within the scope below, avoids privacy violations and service
degradation, and gives us reasonable time to fix the issue before disclosing.
Test against infrastructure you own. Do not test against a live deployment that
is not yours, and never against real employees' devices or data.

---

## What to expect

| Stage | Target |
|---|---|
| Acknowledgement that the report was received | **within 3 business days** |
| Initial triage: confirmed or not, with a severity assessment | **within 7 business days** |
| Fix for a critical or high-severity issue | **within 30 days** of confirmation |
| Fix for a medium or low-severity issue | with the next release, typically **within 90 days** |
| Public advisory and credit | at release, or by agreement with you |

This is a small project, maintained by volunteers, so these are targets rather
than a contractual commitment. If a deadline is going to slip you will be told,
with a reason. You will be kept informed at each stage, and credited in the
advisory unless you would rather not be.

We ask for **90 days** of coordinated disclosure from confirmation, or until a
fix ships, whichever comes first. If we go quiet for 30 days after
acknowledging a confirmed report, consider yourself released from that request.

---

## Supported versions

WorkLens is deployed from source rather than distributed as a binary, and
releases are tagged.

| Version | Supported |
|---|---|
| `main` | Yes — fixes land here first. |
| Latest tagged release | Yes — security fixes are backported and a patch release is tagged. |
| Older tagged releases | No. Upgrade to the latest release. |

Because a deployment is a Terraform stack in the deployer's own AWS account, a
fix reaching `main` does not fix any running deployment. **You must redeploy.**
Watch releases, and treat a security release as an operational task: apply the
Terraform change, redeploy the Lambda bundles, and roll out the agent build.

There is no long-term-support branch. If you need one, fork and backport.

---

## Scope

### In scope

- **Authentication and authorisation**: HMAC request-signature verification,
  replay protection (the timestamp window and the nonce table), device secret
  derivation, enrolment token single-use enforcement, Cognito integration, the
  RBAC middleware, and server-side MFA enforcement on admin routes.
- **Tenant isolation**: any path where `org_id` scoping can be bypassed, or
  where an employee can read another employee's data.
- **Injection and input handling**: SQL injection, unvalidated request bodies,
  path or parameter injection, XSS in the dashboard.
- **Secret exposure**: a secret reachable in a log, an error response, a
  Terraform output, a client bundle, or a database dump.
- **Presigned URL abuse**: a screenshot URL that can be used beyond its
  intended object, method, content type, or lifetime.
- **Agent integrity**: TLS certificate-pinning bypass, local privilege
  escalation, insecure permissions on the credentials file or the local buffer,
  a way to make the agent capture something it must not, or a way to make it
  run without its tray icon.
- **Infrastructure**: an over-broad IAM policy, a publicly reachable S3 object
  or database, a missing encryption control, a WAF or throttling bypass.
- **Privacy-control bypass**: making an exclusion rule, the work-hours window,
  or screenshot blur fail to apply *before* data is written to the local
  buffer. Persisting excluded data is a vulnerability even if it is never
  uploaded.
- **Supply chain**: a compromised dependency or CI action that can reach the
  build or a deployment.

### Out of scope

- Findings against a deployment you do not own or have written permission to
  test.
- Missing hardening with no demonstrable impact, or automated-scanner output
  with no exploit path.
- Vulnerabilities in a deployer's own AWS configuration, or in Vercel, AWS or
  another third-party service (report those to that provider).
- Denial of service through sheer traffic volume, or resource exhaustion that
  requires credentials the attacker should not have in the first place.
- Social engineering of maintainers or deployers, and physical attacks.
- Anything requiring an already-compromised employee device with
  administrator rights.
- Attacks that require the deployer to have deliberately misconfigured a
  documented security control.
- Reports that an outdated dependency exists, without a reachable code path.

---

## The monitoring capability itself is not a security vulnerability

WorkLens collects activity data. That is what it is for, it is documented in
detail, and it is not a bug.

If your concern is that WorkLens *can* record which application an employee
used, that it can be configured to take screenshots, that a deployer could
install it without telling their staff, or that employee monitoring should not
exist — **that belongs in a discussion of responsible use, not in the security
inbox.** Open a [GitHub Discussion](../../discussions) instead. Those questions
are legitimate and we would rather have them in the open, where deployers can
read the answers; the security channel is reserved for defects that let someone
do something the documentation says they cannot.

The line is straightforward:

| Discussion of responsible use | Security report |
|---|---|
| "This tool can capture window titles." | "An employee can read another employee's window titles." |
| "Screenshots are too invasive." | "A screenshot presigned URL can be used to read any object in the bucket." |
| "A deployer could install this covertly." | "The agent can be made to capture with no tray icon and no acknowledged notice." |
| "The retention default is too long." | "The retention sweeper leaves the S3 objects behind, so deleted data is still readable." |
| "Employees cannot meaningfully refuse consent at work." | "The notice acknowledgment can be forged by the deployer without the employee seeing it." |

The right-hand column is a defect against a documented guarantee: report those
privately. The left-hand column is a policy question about a category of
software: bring those to Discussions, and read the **Responsible & Lawful Use**
section of the [README](README.md) first, since it already answers several of
them.

One exception worth stating plainly: if you find that WorkLens *does* capture
something it promises never to capture — keystroke content, passwords,
clipboard contents, webcam or microphone data — that is a security report of
the highest severity, not a discussion. Report it privately and immediately.

---

## Our own security controls

For context on what is already in place — TLS with certificate pinning in the
agent, KMS encryption at rest, per-Lambda least-privilege IAM, private-subnet
database, WAF and rate limiting, strict input validation, CloudTrail plus an
application audit log, and configurable retention with a working hard-delete
path — see Section 6 of [docs/PLAN.md](docs/PLAN.md), and `docs/SECURITY.md`
once it lands.

Three of these are enforced by CI rather than by convention:
`scripts/check-privacy.sh` fails the build on any reference to a forbidden
capture API, `scripts/check-iam.sh` fails on an unjustified IAM resource
wildcard, and gitleaks scans the full history on every push. If you find a way
around one of those gates, that is in scope.
