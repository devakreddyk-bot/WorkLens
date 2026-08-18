MASTER BUILD PROMPT — Employee 
Time-Tracking & Activity Monitoring System 
How to use this file: Paste this entire document into a coding agent (Claude Code 
recommended, or Cursor). Then send one message: "Begin with Phase 0. Plan 
first, do not write code until the plan is complete." 
 
 
0. META-INSTRUCTIONS FOR THE AGENT (read first) 
You are building a complete, production-ready software product from scratch. Follow these rules 
for the entire session: 
 
1. PLAN BEFORE YOU BUILD. Phase 0 is a written plan only. Do not scaffold or write a 
single line of implementation code until the plan in Phase 0 is fully laid out. 
2. Build in the phase order defined in Section 11. Finish and verify a phase before 
starting the next. 
3. No placeholders. Every file you write must be complete and runnable. No // TODO: 
implement, no stub functions, no "the user can fill this in later." If a value must be 
supplied by the deployer, put it in .env.example with a comment. 
4. Self-monitor your remaining capacity. This is critical — see Section 13. When you're 
running low, STOP building and emit a full resume prompt so the work can continue in a 
fresh chat. 
5. This is the author's first public GitHub project. Repo hygiene, documentation, and a 
defensible "responsible use" posture matter as much as the code working. 
 
 
1. MISSION 
Build WorkLens — a transparent employee time-tracking and activity-monitoring system for a 
single company deployment. An agent runs on company-issued laptops, captures work 
activity, sends it securely to an AWS backend, and the backend turns raw activity into daily 
timesheets that a company owner reviews and exports for payroll. 
 
Core user story: Employee uses a company-issued laptop → the agent runs in the background 
(visibly) → it captures active application, window title, websites visited, active-vs-idle time, 
periodic screenshots, and per-app/per-project time → it batches this securely to an AWS 
backend → a scheduled job aggregates the raw events into a daily timesheet → the company 

owner reviews timesheets and activity in a web dashboard and exports them for payroll and 
review. 
 
 
2. HARD CONSTRAINTS (NON-NEGOTIABLE) 
These define the product. Do not violate them, do not add features that break them, do not 
"make it configurable" to allow breaking them. 
 
- NO keystroke content capture. Detect input activity level only (was there 
keyboard/mouse input in the last N seconds → active vs idle), via last-input timing. 
Never record which keys were pressed or what was typed. 
- No password capture. No webcam. No microphone. No clipboard content capture. 
- The agent is visible and transparent. System tray icon showing monitoring is active, a 
first-run notice screen the employee acknowledges, and a clear indicator whenever it's 
running. 
- Least-invasive defaults. Every collection setting defaults to the minimum that still 
produces a defensible timesheet. 
- Configurable privacy rules: work-hours-only mode, excluded apps and URL patterns 
(banking, health, personal email), and a screenshot-blur option — all respected by the 
agent locally before anything is uploaded. 
- Secure by default (Section 9). This system holds sensitive personal data; treat it that 
way. 
- Responsible-use documentation is mandatory (Section 10). The deployer is told to 
obtain legal sign-off for lawful, transparent, consented monitoring (India's DPDP Act if 
deployed there). 
 
 
3. TECH STACK (opinionated, lean — deviate only with 
justification in the plan) 
- Agent: Go (single static binary, cross-compiles; Windows first, structured so macOS 
can be added later). 
- Windows APIs via golang.org/x/sys/windows: GetForegroundWindow, 
GetWindowText (active window + title), GetLastInputInfo (idle detection), 
process enumeration for the active app. 
- Screenshots via a Go screenshot library (e.g. kbinani/screenshot). 
- Local SQLite buffer for offline resilience; batched HTTPS upload with 
retry/backoff. 
- Backend: AWS. 

- API Gateway (HTTP API) → Lambda (Go or TypeScript/Node — pick one, 
justify). 
- PostgreSQL (RDS db.t4g.micro or Aurora Serverless v2) for orgs, devices, 
events, timesheets. 
- S3 for screenshots (server-side encryption with KMS; presigned upload URLs). 
- EventBridge scheduled rule → aggregation Lambda (nightly + on-demand). 
- Cognito for dashboard user auth. 
- Frontend: Next.js (App Router) + TypeScript + Tailwind CSS. Recharts for charts. 
Deploy target: Vercel or AWS Amplify. 
- Infrastructure as Code: Terraform (preferred) or AWS CDK — the entire backend must 
be reproducible with one terraform apply. This is essential for handoff to the client. 
- Everything reproducible. Provide Makefile / scripts for build, test, deploy. 
 
 
4. ARCHITECTURE & DATA FLOW 
Produce a clear architecture description (and an ASCII or Mermaid diagram in the README) 
covering: 
 
- Enrollment: an org admin generates a device-enrollment token → the agent uses it 
once to register the device and receive a long-lived, org-scoped device credential 
(signed JWT or mutual TLS). 
- Ingestion path: Agent batches events locally → POSTs over TLS to API Gateway → 
Lambda validates the device credential, validates and de-duplicates the payload 
(idempotency key per batch) → writes raw events to Postgres and/or S3. 
- Screenshots: Agent requests a presigned S3 URL from the backend → uploads the 
(optionally blurred) image directly to S3 (KMS-encrypted) → records the reference in 
Postgres. 
- Aggregation: scheduled Lambda rolls raw events into a per-employee daily timesheet: 
total active time, idle time, time per app, time per category, time per project, first activity, 
last activity. 
- Serving: dashboard queries reporting APIs (Lambda) which read aggregated timesheets 
+ activity. 
 
Data model (minimum tables): organizations, users (dashboard users with roles), 
employees, devices, activity_events, screenshots, timesheets, projects, 
monitoring_config, audit_log. Every table is scoped by org_id even though it's a 
single-tenant deployment — design for isolation from day one. 
 
 

5. BACKEND — FEATURE LIST 
- Device enrollment + per-device authentication (org-scoped) 
- Batched event ingestion endpoint (validated, idempotent, rate-limited) 
- Screenshot upload via presigned KMS-encrypted S3 URLs 
- Timesheet aggregation job (scheduled + manual trigger) 
- Reporting/query APIs for the dashboard (team overview, per-employee, per-project, date 
ranges) 
- Monitoring-config API (admin sets rules per org: intervals, exclusions, work hours, 
screenshot on/off/blur, retention days) 
- Data-retention + hard-delete endpoints (support an employee-data-deletion request) 
- Audit log (record who viewed whose data) 
 
 
6. AGENT — FEATURE LIST 
- One-time enrollment + periodic config fetch 
- Active window + active application sampling (configurable interval) 
- Website/URL capture from the active browser (via active-tab title / window title; 
document the approach and its limits) 
- Idle detection via last-input timing (activity level only — never key content) 
- Screenshot capture on interval, respecting blur + exclusion + work-hours config before 
upload 
- Local SQLite buffer + batched upload with retry/exponential backoff (survives offline) 
- System tray icon: status, "monitoring active", first-run acknowledgment notice 
- Auto-start on boot, run as a background service, restart on crash 
- Respect all exclusion rules and the work-hours window locally 
- Graceful shutdown + graceful offline/online transitions 
 
 
7. FRONTEND DASHBOARD — FEATURE LIST 
- Cognito login + RBAC (owner / manager / employee) 
- Team overview: today's totals, recent activity, who's active 
- Per-employee timesheet: day and week views, active vs idle, top apps, top sites, 
per-project breakdown 
- Screenshot gallery (only if enabled), with privacy controls 
- Reports + CSV and PDF export for payroll 
- Employee self-view — each employee can see their own data (trust + compliance 
feature) 

- Admin settings: monitoring rules, retention, user management 
- Audit-log view for admins 
 
 
8. (reserved) 
 
9. SECURITY REQUIREMENTS (checklist the build must satisfy) 
- TLS for all traffic; certificate pinning in the agent 
- Encryption at rest: KMS/AES-256 for RDS and S3 
- Least-privilege IAM roles per Lambda; secrets in AWS Secrets Manager, never 
hardcoded, never committed 
- Cognito with MFA required for admin accounts 
- org_id scoping enforced on every query 
- Database in a private subnet (no public access); WAF + rate limiting on the API 
- Strict input validation; parameterized queries only (no string-built SQL) 
- .gitignore covers keys, .env, build artifacts, SQLite files, Terraform state 
- .env.example for every service; real values never in the repo 
- CloudTrail enabled + application-level audit log 
- Configurable data retention + working hard-delete path 
 
 
10. GITHUB / OPEN-SOURCE REQUIREMENTS (first public 
project — make it clean) 
- Monorepo layout: /agent, /backend, /infra, /dashboard, /docs 
- README.md with: what it is, architecture diagram (Mermaid), feature list, 
screenshots/GIFs placeholders, prerequisites, step-by-step deploy (Terraform → 
backend → agent build → dashboard), configuration reference, and a prominent 
"Responsible & Lawful Use" section. 
- The Responsible Use section must state: this is a transparent workplace productivity 
tool; it does not capture keystroke content, passwords, webcam, or mic; deployers must 
obtain informed employee notice/consent and legal sign-off for their jurisdiction (call out 
India's DPDP Act explicitly since that's the target deployment). 
- LICENSE (MIT). 
- .gitignore (Go + Node + Terraform + env + build artifacts). 
- CONTRIBUTING.md and a GitHub Actions CI workflow: lint + build + test on push. 
- Tests: unit tests on the aggregation logic and the API handlers at minimum. 

- Conventional commit messages. No secrets ever committed. Tag a v0.1.0 release at the 
end. 
 
 
11. BUILD PHASES (execute in order; Phase 0 is plan-only) 
- Phase 0 — PLAN. Deliver a complete written plan: chosen stack (with any justified 
deviations), architecture diagram, full data model, API surface, agent design, dashboard 
page map, security plan, repo structure, and the ordered task breakdown for Phases 
1–7. No code yet. 
- Phase 1 — Scaffold. Monorepo structure, Terraform for all AWS resources, database 
schema/migrations, README skeleton, .gitignore, .env.example files, CI 
workflow. 
- Phase 2 — Backend core. Enrollment + auth, event ingestion, screenshot 
presigned-URL flow, DB writes, validation, rate limiting. 
- Phase 3 — Agent (Windows). Capture loop, idle detection, screenshots, SQLite buffer, 
batched upload, tray icon + first-run notice, service install + auto-start. 
- Phase 4 — Aggregation + reporting. Timesheet aggregation job + reporting/query 
APIs. 
- Phase 5 — Dashboard. Auth, RBAC, all pages in Section 7, exports. 
- Phase 6 — Hardening + tests. Security checklist pass, unit tests, CI green. 
- Phase 7 — Docs + release. Full README, config reference, architecture diagram, 
responsible-use section, docs/, tag v0.1.0. 
 
At the end of every phase, print a short status line: phase complete, files added/changed, what's 
next. 
 
 
12. QUALITY BAR 
- Production-ready and deployable by following the README with zero tribal knowledge. 
- Fully typed, linted, commented where logic is non-obvious. 
- No placeholders, no dead code, no committed secrets. 
- Every deployer-supplied value lives in .env.example with an explanatory comment. 
 
 

13. CHECKPOINT / RESUME MECHANISM (do this without 
being reminded) 
You have a limited context/usage budget in this session. Manage it actively. 
 
- Continuously self-monitor your remaining capacity. As you approach roughly 
15–20% remaining, STOP starting new work immediately. 
 
- Use the remaining budget to emit one fenced block, exactly titled: 
 
=== RESUME CONTEXT PROMPT — PASTE INTO A NEW CHAT === 
 
- That block must be fully self-contained — assume the next chat has ZERO memory of 
this one. Include: 
 
1. Mission + hard constraints (condensed but complete — including the 
no-keystroke-content rule). 
2. Chosen tech stack and any deviations made, with reasons. 
3. Current repo file tree. 
4. What is DONE — per phase, per key file, with status. 
5. What is IN PROGRESS — exact file, exact function, and what's half-written. 
6. What is NEXT — the ordered remaining task list. 
7. Key decisions and gotchas discovered so far. 
8. Config/secret placeholders the user still needs to fill. 
9. The exact next instruction to give the fresh agent (e.g. "Continue Phase 3: 
finish the screenshot upload retry logic in agent/uploader.go"). 
 
- Also write this same content to /docs/RESUME.md at every checkpoint so progress is 
version-controlled and never lost. 
 
- After emitting the resume prompt, stop. Do not start new work on low budget. 
 
 
 
End of master build prompt. Replace WorkLens, paste into your coding agent, and say: 
"Begin with Phase 0. Plan first, do not write code until the plan is complete." 
 
