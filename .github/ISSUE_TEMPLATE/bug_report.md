---
name: Bug report
about: Something behaves differently from how it is documented
title: "bug: "
labels: ["bug", "needs-triage"]
assignees: []
---

<!-- Before filing: this is a public repository. Do not paste device secrets,
     enrolment tokens, Cognito tokens, AWS account IDs, employee names,
     window titles, or screenshots of real employee activity. Redact them. -->

## Which component

- [ ] `agent` — the Go agent on Windows
- [ ] `backend` — Lambdas, ingestion, aggregation
- [ ] `dashboard` — the Next.js UI
- [ ] `infra` — Terraform
- [ ] `docs` — documentation is wrong or missing
- [ ] Not sure

## What happened

<!-- Observed behaviour, in one or two sentences. -->

## What you expected

<!-- And where that expectation comes from — README, docs/, an error message. -->

## Steps to reproduce

1.
2.
3.

## Evidence

<!-- Redacted logs, the failing CI job, or the exact error text. For agent
     issues, the output of `worklens-agentctl doctor` is the single most
     useful thing you can attach. Wrap output in a code fence. -->

```
```

## Environment

| | |
|---|---|
| WorkLens version / commit | |
| Component version (agent build, Lambda, dashboard) | |
| OS and version | |
| Go / Node / Terraform version, if relevant | |
| AWS region | |
| Screenshots enabled? | |
| Work-hours-only enabled? | |

## Impact

- [ ] Data loss — activity or timesheets are missing or wrong
- [ ] **Privacy** — data is collected, retained or exposed contrary to the
      documented hard constraints (if this is exploitable, use a private
      security advisory instead; see `SECURITY.md`)
- [ ] Deployment blocker — cannot get it running by following the README
- [ ] Incorrect timesheet figures — payroll would be wrong
- [ ] Cosmetic or minor

## Anything else

<!-- Workarounds you found, when it started, what changed beforehand. -->
