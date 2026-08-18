## What this changes

<!-- One or two sentences. What behaviour is different after this merges? -->

## Why

<!-- The problem, the bug report, or the requirement this serves. Link the
     issue: "Closes #123". -->

## Type of change

<!-- Tick every box that applies. This should match your Conventional Commit
     type — see CONTRIBUTING.md. -->

- [ ] `fix` — bug fix, no behaviour change beyond the fix
- [ ] `feat` — new capability
- [ ] `refactor` — no behaviour change at all
- [ ] `perf` — measurably faster or cheaper
- [ ] `docs` — documentation only
- [ ] `test` — tests only
- [ ] `build` / `ci` / `chore` — tooling, pipeline, dependencies
- [ ] Breaking change (describe the migration path below)

## Privacy impact

**Every pull request must answer this.** WorkLens processes employees' personal
data, and its hard constraints are a product promise, not an implementation
detail. Tick exactly one.

- [ ] **This change does not touch data collection, storage, retention, access or export.**
- [ ] **This change touches data collection.** I have completed the section below.

<details>
<summary>Complete this if you ticked the second box</summary>

**What new data is collected, stored, or exposed?**

<!-- Name the exact fields, tables, columns, S3 keys or API responses. -->

**Why is it necessary?**

<!-- What question about a timesheet cannot be answered without it? If the
     answer is "it might be useful later", the answer is to not collect it. -->

**Who can see it, and is that access audited?**

**How long is it retained, and which retention setting governs it?**

**Confirm the hard constraints still hold:**

- [ ] No keystroke content, key codes or raw input is captured.
- [ ] No password, clipboard, webcam or microphone data is captured.
- [ ] Exclusion rules, work-hours rules and blur are still applied on the
      device *before* anything is written to the local buffer.
- [ ] `org_id` scoping is enforced on every new query.
- [ ] The change is reflected in `README.md` and `docs/RESPONSIBLE_USE.md` if
      it alters what a deployer must tell employees.

</details>

<!-- If this PR adds an entry to scripts/privacy-allowlist.txt or a
     "# iam-wildcard-ok:" annotation, say so here and justify it. Those
     entries switch off a build gate and need a second reader's agreement. -->

## Security impact

- [ ] No new secret, credential, token or key material is introduced.
- [ ] No new IAM permission is granted, or each new permission is scoped to
      explicit ARNs (or annotated with `# iam-wildcard-ok:` and a reason).
- [ ] All new SQL uses parameterised queries; no string-built SQL.
- [ ] All new request bodies are validated at the handler boundary.

## How this was tested

<!-- Commands you ran, and what you observed. "CI is green" is not a test
     plan for a behaviour change. For agent changes, say whether it was
     exercised on real Windows or only cross-compiled. -->

```
make ci
```

## Checklist

- [ ] `make ci` passes locally (or the failure is explained above).
- [ ] Commits follow Conventional Commits and the branch is named per
      `CONTRIBUTING.md`.
- [ ] New behaviour has tests; aggregation and handler changes have unit tests.
- [ ] Documentation updated (`README.md`, `docs/`, `.env.example` comments).
- [ ] `CHANGELOG.md` has an entry under `## [Unreleased]` for anything a user
      or deployer would notice.
- [ ] No secrets, real ARNs, account IDs, employee names or captured data in
      the diff — including in test fixtures and screenshots.
- [ ] Reviewed my own diff line by line before requesting review.
