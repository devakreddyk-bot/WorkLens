-- 0001_init.sql — WorkLens initial schema
--
-- PostgreSQL 16. Forward-only migrations: this file is never edited after it has been
-- applied anywhere. Corrections ship as a new numbered migration.
--
-- Conventions used throughout:
--   * Every tenant-scoped table carries org_id, even though WorkLens is deployed
--     single-tenant. Isolation is designed in from day one (see docs/PLAN.md §3).
--   * Timestamps are timestamptz and are stored in UTC. Calendar days (work_date) are
--     plain `date` values interpreted in the employee's IANA timezone.
--   * Status/enum-like columns are `text` with CHECK constraints rather than Postgres
--     ENUM types, because adding a value to an ENUM inside a forward-only migration
--     chain is awkward and cannot be done inside a transaction on older versions.
--   * Weekday numbering is ISO-8601: 1 = Monday ... 7 = Sunday. This matches
--     Postgres `extract(isodow from ...)`. Note that `extract(dow ...)` is 0 = Sunday;
--     the two are never mixed in this codebase.
--
-- PRIVACY INVARIANT — read before adding any column:
--   There is no column in this schema for keystroke content, key codes, clipboard
--   contents, audio, or video, and none may ever be added. The agent does not collect
--   these (docs/PLAN.md §0), scripts/check-privacy.sh fails the build if the word
--   "keystroke" appears in any .sql file, and a migration that introduces such a column
--   would be a breaking change to the product's stated guarantees, not a feature.

create extension if not exists citext;

-- ---------------------------------------------------------------------------
-- Migration bookkeeping
-- ---------------------------------------------------------------------------

create table if not exists schema_migrations (
    version    text        primary key,
    checksum   text        not null,
    applied_at timestamptz not null default now()
);

comment on table schema_migrations is
    'One row per applied migration file. checksum is the sha256 of the file contents at '
    'apply time; the runner refuses to proceed if an already-applied file has changed.';

-- ---------------------------------------------------------------------------
-- Shared helper: updated_at maintenance
-- ---------------------------------------------------------------------------

create or replace function wl_touch_updated_at() returns trigger
    language plpgsql
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

comment on function wl_touch_updated_at() is
    'BEFORE UPDATE trigger function that stamps updated_at. Applied to every table that '
    'has an updated_at column so the value cannot be forgotten at the call site.';

-- ---------------------------------------------------------------------------
-- Organisations
-- ---------------------------------------------------------------------------

create table organizations (
    id         uuid        primary key default gen_random_uuid(),
    name       text        not null check (length(btrim(name)) between 1 and 200),
    slug       text        not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
    -- Default IANA timezone for employees who do not override it. Validated by the
    -- application against the tz database; Postgres cannot constrain this natively
    -- without a lookup against pg_timezone_names, which is done in the API layer.
    timezone   text        not null default 'Asia/Kolkata' check (length(timezone) between 3 and 64),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create trigger organizations_touch before update on organizations
    for each row execute function wl_touch_updated_at();

comment on table organizations is
    'The deploying company. A single-company deployment has exactly one row, but every '
    'tenant-scoped table joins back to here so multi-org isolation is already enforced.';

-- ---------------------------------------------------------------------------
-- Employees — the people being monitored
-- ---------------------------------------------------------------------------

create table employees (
    id          uuid        primary key default gen_random_uuid(),
    org_id      uuid        not null references organizations (id) on delete cascade,
    full_name   text        not null check (length(btrim(full_name)) between 1 and 200),
    email       citext      not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    -- Payroll or HRIS identifier, so exports can be reconciled without name matching.
    external_ref text,
    -- IANA timezone. Timesheet day boundaries are computed in this zone, which is why
    -- it lives on the employee and not only on the org: a distributed team's "Tuesday"
    -- differs per person.
    timezone    text        not null check (length(timezone) between 3 and 64),
    status      text        not null default 'active' check (status in ('active', 'inactive')),
    hired_on    date,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    constraint employees_org_email_uq unique (org_id, email)
);

create index employees_org_status_idx on employees (org_id, status);

create trigger employees_touch before update on employees
    for each row execute function wl_touch_updated_at();

comment on column employees.timezone is
    'IANA zone used for this employee''s timesheet day boundaries. Defaults to the '
    'organisation timezone when created through the API.';

-- ---------------------------------------------------------------------------
-- Dashboard users
-- ---------------------------------------------------------------------------

create table users (
    id           uuid        primary key default gen_random_uuid(),
    org_id       uuid        not null references organizations (id) on delete cascade,
    -- Cognito `sub`. The authoritative identity; email is a mutable convenience copy.
    cognito_sub  text        not null unique,
    email        citext      not null,
    role         text        not null check (role in ('owner', 'manager', 'employee')),
    -- Set when this dashboard login belongs to a monitored employee, which is what
    -- powers the employee self-view. Null for admin-only accounts.
    employee_id  uuid        references employees (id) on delete set null,
    status       text        not null default 'active' check (status in ('active', 'disabled')),
    last_login_at timestamptz,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),

    constraint users_org_email_uq unique (org_id, email),
    -- An 'employee' role account is meaningless without the employee it can see.
    constraint users_employee_role_chk check (role <> 'employee' or employee_id is not null)
);

create index users_org_role_idx on users (org_id, role);
create index users_employee_idx on users (employee_id) where employee_id is not null;

create trigger users_touch before update on users
    for each row execute function wl_touch_updated_at();

comment on constraint users_employee_role_chk on users is
    'Role "employee" grants access to exactly one employee''s data, so employee_id is '
    'mandatory for that role. Enforced in the database because the RBAC middleware '
    'depends on it being non-null.';

-- ---------------------------------------------------------------------------
-- Projects and the rules that map raw activity onto them
-- ---------------------------------------------------------------------------

create table projects (
    id         uuid        primary key default gen_random_uuid(),
    org_id     uuid        not null references organizations (id) on delete cascade,
    name       text        not null check (length(btrim(name)) between 1 and 120),
    code       text        check (code is null or length(btrim(code)) between 1 and 40),
    is_active  boolean     not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint projects_org_name_uq unique (org_id, name)
);

create trigger projects_touch before update on projects
    for each row execute function wl_touch_updated_at();

create table project_rules (
    id         uuid        primary key default gen_random_uuid(),
    org_id     uuid        not null references organizations (id) on delete cascade,
    project_id uuid        not null references projects (id) on delete cascade,
    match_type text        not null check (match_type in ('app_exe', 'url_host', 'title_contains', 'title_regex')),
    pattern    text        not null check (length(btrim(pattern)) between 1 and 400),
    -- Lowest priority number wins. Ties are broken by created_at, then id, so rule
    -- evaluation is fully deterministic and the aggregation job is reproducible.
    priority   integer     not null default 100 check (priority between 0 and 10000),
    created_at timestamptz not null default now(),

    constraint project_rules_uq unique (org_id, project_id, match_type, pattern)
);

create index project_rules_eval_idx on project_rules (org_id, priority, created_at, id);

comment on table project_rules is
    'Declarative mapping from observed activity to a project. Evaluated in (priority, '
    'created_at, id) order; the first match wins. title_regex patterns are applied with '
    'a length cap and a match timeout in the aggregation job to bound cost.';

-- ---------------------------------------------------------------------------
-- App/site categorisation
-- ---------------------------------------------------------------------------

create table app_categories (
    id         uuid        primary key default gen_random_uuid(),
    org_id     uuid        not null references organizations (id) on delete cascade,
    match_type text        not null check (match_type in ('app_exe', 'url_host')),
    pattern    text        not null check (length(btrim(pattern)) between 1 and 400),
    category   text        not null check (length(btrim(category)) between 1 and 60),
    priority   integer     not null default 100 check (priority between 0 and 10000),
    created_at timestamptz not null default now(),

    constraint app_categories_uq unique (org_id, match_type, pattern)
);

create index app_categories_eval_idx on app_categories (org_id, priority, created_at, id);

-- ---------------------------------------------------------------------------
-- Devices and enrollment
-- ---------------------------------------------------------------------------

create table devices (
    id                   uuid        primary key default gen_random_uuid(),
    org_id               uuid        not null references organizations (id) on delete cascade,
    employee_id          uuid        not null references employees (id) on delete cascade,
    hostname             text        not null check (length(btrim(hostname)) between 1 and 255),
    os                   text        not null check (os in ('windows', 'darwin', 'linux')),
    os_version           text        not null default '',
    agent_version        text        not null default '',
    -- Stable, non-identifying machine hash produced by the agent. Used to detect a
    -- re-enrollment of the same laptop, not to fingerprint a person.
    machine_fingerprint  text        not null default '',

    -- Which device-root-key version this device's derived secret came from.
    -- No secret material is stored here — the secret is derived on demand from the
    -- root key in Secrets Manager (docs/PLAN.md deviation D4), so a database dump
    -- yields no working device credentials.
    key_version          integer     not null default 1 check (key_version > 0),

    enrolled_at          timestamptz not null default now(),
    last_seen_at         timestamptz,
    last_config_fetch_at timestamptz,
    revoked_at           timestamptz,

    -- First-run transparency notice. Capture does not begin on the device until this
    -- is acknowledged locally; the acknowledgment is then uploaded and recorded here
    -- so the deployer can evidence that every monitored user was informed.
    notice_acknowledged_at timestamptz,

    -- Per-device leaky bucket for application-level rate limiting, on top of the WAF
    -- rate rule and the API Gateway stage throttle.
    quota_window_started_at timestamptz not null default now(),
    quota_event_count       integer     not null default 0 check (quota_event_count >= 0),

    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now()
);

create index devices_org_employee_idx on devices (org_id, employee_id);
create index devices_org_last_seen_idx on devices (org_id, last_seen_at desc nulls last);
create index devices_active_idx on devices (org_id) where revoked_at is null;

create trigger devices_touch before update on devices
    for each row execute function wl_touch_updated_at();

comment on column devices.revoked_at is
    'Set to revoke the device. Checked on every authenticated request, so revocation '
    'takes effect on the next call rather than after a credential TTL expires.';

create table enrollment_tokens (
    id                 uuid        primary key default gen_random_uuid(),
    org_id             uuid        not null references organizations (id) on delete cascade,
    employee_id        uuid        not null references employees (id) on delete cascade,
    -- sha256 of the token presented to the operator. The token itself is shown exactly
    -- once, at creation, and is not recoverable from this table.
    token_hash         bytea       not null unique check (octet_length(token_hash) = 32),
    expires_at         timestamptz not null,
    used_at            timestamptz,
    used_by_device_id  uuid        references devices (id) on delete set null,
    created_by_user_id uuid        references users (id) on delete set null,
    created_at         timestamptz not null default now(),

    constraint enrollment_tokens_used_chk check ((used_at is null) = (used_by_device_id is null))
);

create index enrollment_tokens_open_idx on enrollment_tokens (org_id, expires_at)
    where used_at is null;

comment on table enrollment_tokens is
    'Single-use, time-limited device enrollment tokens. Consumption is an UPDATE ... '
    'WHERE used_at IS NULL RETURNING, so two concurrent enrollments cannot both win.';

-- ---------------------------------------------------------------------------
-- Ingest bookkeeping: batch idempotency and replay protection
-- ---------------------------------------------------------------------------

create table ingest_batches (
    id              uuid        primary key default gen_random_uuid(),
    org_id          uuid        not null references organizations (id) on delete cascade,
    device_id       uuid        not null references devices (id) on delete cascade,
    -- Client-computed key: sha256 over the sorted client_event_id list in the batch.
    idempotency_key text        not null check (length(idempotency_key) between 16 and 128),
    event_count     integer     not null check (event_count >= 0),
    byte_count      integer     not null check (byte_count >= 0),
    received_at     timestamptz not null default now(),

    constraint ingest_batches_device_key_uq unique (device_id, idempotency_key)
);

create index ingest_batches_received_idx on ingest_batches (received_at);

comment on table ingest_batches is
    'One row per accepted upload batch. The unique constraint is what makes agent '
    'retries free: a duplicate INSERT ... ON CONFLICT DO NOTHING returns no row and the '
    'handler answers 200 with duplicate=true so the agent can drop its local copy.';

create table device_nonces (
    device_id uuid        not null references devices (id) on delete cascade,
    nonce     text        not null check (length(nonce) between 16 and 64),
    seen_at   timestamptz not null default now(),

    primary key (device_id, nonce)
);

-- Swept hourly; only the trailing edge of the accepted timestamp window needs to be kept.
create index device_nonces_seen_idx on device_nonces (seen_at);

comment on table device_nonces is
    'Replay protection for HMAC-signed device requests (docs/PLAN.md deviation D3). A '
    'request is rejected if its nonce has been seen, or if its timestamp falls outside '
    'the accepted window. Rows older than the window are deleted hourly.';

-- ---------------------------------------------------------------------------
-- Raw activity
-- ---------------------------------------------------------------------------

create table activity_events (
    id               bigint      generated always as identity primary key,
    org_id           uuid        not null references organizations (id) on delete cascade,
    employee_id      uuid        not null references employees (id) on delete cascade,
    device_id        uuid        not null references devices (id) on delete cascade,

    -- Client-generated identity, used for per-event idempotency across retries.
    client_event_id  uuid        not null,

    event_type       text        not null check (event_type in (
                         'window_sample',   -- foreground app/window observed for a span
                         'idle_state',      -- transition into or out of idle
                         'session_start',   -- agent started capturing
                         'session_end',     -- agent stopped capturing cleanly
                         'notice_ack',      -- employee acknowledged the first-run notice
                         'agent_health'     -- buffer overflow, capture error, version change
                     )),

    captured_at      timestamptz not null,
    -- Span covered by this event. Capped at one hour so a stalled clock or a laptop
    -- resumed from sleep cannot inject an implausible span into a timesheet.
    duration_seconds integer     not null default 0 check (duration_seconds between 0 and 3600),

    -- Activity attribution. All nullable: when the sample is idle, or when the relevant
    -- capture setting is disabled, the agent sends nothing rather than a placeholder.
    app_name         text        check (app_name is null or length(app_name) <= 200),
    app_exe          text        check (app_exe is null or length(app_exe) <= 400),
    window_title     text        check (window_title is null or length(window_title) <= 500),
    url_host         text        check (url_host is null or length(url_host) <= 253),
    url_title        text        check (url_title is null or length(url_title) <= 500),

    category         text        check (category is null or length(category) <= 60),
    project_id       uuid        references projects (id) on delete set null,
    is_idle          boolean     not null,

    created_at       timestamptz not null default now(),

    constraint activity_events_device_client_uq unique (device_id, client_event_id),
    -- Idle time is attributed to no application. Enforcing it here means an agent bug
    -- or a hand-crafted payload cannot associate an app or a window title with idle
    -- minutes, which is the guarantee docs/RESPONSIBLE_USE.md makes to employees.
    constraint activity_events_idle_no_attribution_chk check (
        not is_idle
        or (app_name is null and app_exe is null and window_title is null
            and url_host is null and url_title is null)
    )
);

create index activity_events_employee_time_idx
    on activity_events (org_id, employee_id, captured_at);
create index activity_events_recent_idx
    on activity_events (org_id, captured_at desc);
create index activity_events_device_time_idx
    on activity_events (device_id, captured_at desc);
create index activity_events_project_idx
    on activity_events (org_id, project_id, captured_at)
    where project_id is not null;

comment on table activity_events is
    'Raw activity samples. NOTE: there is deliberately no column for keystroke content, '
    'key codes, clipboard contents, audio or video, and none may be added — see the '
    'privacy invariant at the top of this file.';

comment on column activity_events.duration_seconds is
    'Seconds of wall time this sample represents. Consecutive identical samples are '
    'coalesced on the agent into one event with a summed duration, which reduces event '
    'volume roughly 10-20x on typical usage.';

-- ---------------------------------------------------------------------------
-- Screenshots
-- ---------------------------------------------------------------------------

create table screenshots (
    id           uuid        primary key default gen_random_uuid(),
    org_id       uuid        not null references organizations (id) on delete cascade,
    employee_id  uuid        not null references employees (id) on delete cascade,
    device_id    uuid        not null references devices (id) on delete cascade,
    captured_at  timestamptz not null,
    s3_bucket    text        not null check (length(s3_bucket) between 3 and 63),
    s3_key       text        not null unique check (length(s3_key) between 1 and 1024),
    content_type text        not null default 'image/png' check (content_type in ('image/png', 'image/jpeg')),
    width        integer     not null check (width between 1 and 20000),
    height       integer     not null check (height between 1 and 20000),
    byte_count   integer     not null check (byte_count between 0 and 20971520),
    sha256       bytea       not null check (octet_length(sha256) = 32),
    -- Whether the blur privacy control was applied on the device before upload.
    -- Surfaced in the dashboard so a viewer always knows what they are looking at.
    blurred      boolean     not null,
    upload_state text        not null default 'pending'
                     check (upload_state in ('pending', 'uploaded', 'expired')),
    uploaded_at  timestamptz,
    created_at   timestamptz not null default now(),

    constraint screenshots_uploaded_chk check ((upload_state = 'uploaded') = (uploaded_at is not null))
);

create index screenshots_employee_time_idx
    on screenshots (org_id, employee_id, captured_at desc);
-- Drives the sweep of presign requests that never completed their upload.
create index screenshots_pending_idx on screenshots (created_at)
    where upload_state = 'pending';

comment on column screenshots.s3_key is
    'Object key in the KMS-encrypted screenshots bucket. Image bytes never transit '
    'Lambda: the agent PUTs directly to a constrained presigned URL.';

-- ---------------------------------------------------------------------------
-- Monitoring configuration — one row per org, the agent's source of truth
-- ---------------------------------------------------------------------------

create table monitoring_config (
    org_id                      uuid        primary key references organizations (id) on delete cascade,
    -- Bumped on every change. The agent polls, compares, and reloads without restarting.
    config_version              integer     not null default 1 check (config_version > 0),

    sample_interval_seconds     integer     not null default 60
                                    check (sample_interval_seconds between 15 and 900),
    idle_threshold_seconds      integer     not null default 300
                                    check (idle_threshold_seconds between 60 and 3600),

    -- Capture toggles. The defaults below are the least-invasive set that still
    -- produces a defensible timesheet: titles on, URLs off, screenshots off,
    -- work-hours-only on. Anything more is a deliberate act by the deployer.
    capture_window_titles       boolean     not null default true,
    capture_urls                boolean     not null default false,
    screenshot_enabled          boolean     not null default false,
    screenshot_interval_seconds integer     not null default 900
                                    check (screenshot_interval_seconds between 60 and 7200),
    screenshot_blur             boolean     not null default true,

    work_hours_only             boolean     not null default true,
    work_hours_start            time        not null default '09:00',
    work_hours_end              time        not null default '17:30',
    -- ISO-8601 weekdays: 1 = Monday ... 7 = Sunday. Matches extract(isodow from ...).
    work_days                   smallint[]  not null default '{1,2,3,4,5}',

    -- Case-insensitive substring match against the executable path or name.
    excluded_apps               text[]      not null default '{}',
    -- Glob-style patterns matched against the derived host and the raw window title.
    excluded_url_patterns       text[]      not null default '{}',

    retention_days_events       integer     not null default 90
                                    check (retention_days_events between 1 and 3650),
    retention_days_screenshots  integer     not null default 30
                                    check (retention_days_screenshots between 1 and 3650),

    updated_by_user_id          uuid        references users (id) on delete set null,
    updated_at                  timestamptz not null default now(),

    constraint monitoring_config_work_hours_chk check (work_hours_start <> work_hours_end),
    constraint monitoring_config_work_days_chk check (
        array_length(work_days, 1) between 1 and 7
        and work_days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]
    ),
    -- Screenshot retention may not exceed event retention: keeping images longer than
    -- the activity that explains them serves no legitimate purpose.
    constraint monitoring_config_retention_chk check (
        retention_days_screenshots <= retention_days_events
    )
);

comment on table monitoring_config is
    'The single source of truth for what the agent collects. Column defaults are the '
    'least-invasive configuration (screenshots and URL capture off, work-hours-only on) '
    'as required by the product''s hard constraints.';

comment on column monitoring_config.work_hours_start is
    'Interpreted in the employee''s timezone. A window where end < start is treated as '
    'spanning midnight, which is why start = end is rejected rather than meaning '
    '"all day" — an all-day window is expressed by setting work_hours_only = false.';

-- ---------------------------------------------------------------------------
-- Aggregated timesheets
-- ---------------------------------------------------------------------------

create table timesheets (
    id                 uuid        primary key default gen_random_uuid(),
    org_id             uuid        not null references organizations (id) on delete cascade,
    employee_id        uuid        not null references employees (id) on delete cascade,
    work_date          date        not null,
    -- The timezone the day boundaries were computed in, captured at aggregation time so
    -- a later change to employees.timezone does not silently reinterpret history.
    timezone           text        not null,

    active_seconds     integer     not null default 0 check (active_seconds >= 0),
    idle_seconds       integer     not null default 0 check (idle_seconds >= 0),
    total_seconds      integer     not null default 0 check (total_seconds >= 0),

    first_activity_at  timestamptz,
    last_activity_at   timestamptz,

    screenshot_count   integer     not null default 0 check (screenshot_count >= 0),
    source_event_count integer     not null default 0 check (source_event_count >= 0),

    -- Incremented on every recomputation, so a stale dashboard read is detectable.
    version            integer     not null default 1 check (version > 0),
    computed_at        timestamptz not null default now(),
    created_at         timestamptz not null default now(),

    constraint timesheets_employee_date_uq unique (org_id, employee_id, work_date),
    constraint timesheets_totals_chk check (total_seconds = active_seconds + idle_seconds),
    constraint timesheets_activity_order_chk check (
        first_activity_at is null
        or last_activity_at is null
        or first_activity_at <= last_activity_at
    )
);

create index timesheets_org_date_idx on timesheets (org_id, work_date desc);
create index timesheets_employee_date_idx on timesheets (org_id, employee_id, work_date desc);

comment on table timesheets is
    'Per-employee, per-day rollup produced by the aggregation job. Upserted on '
    '(org_id, employee_id, work_date), so re-running a night is always safe.';

create table timesheet_app_totals (
    timesheet_id uuid    not null references timesheets (id) on delete cascade,
    app_name     text    not null,
    seconds      integer not null check (seconds >= 0),
    primary key (timesheet_id, app_name)
);

create table timesheet_site_totals (
    timesheet_id uuid    not null references timesheets (id) on delete cascade,
    url_host     text    not null,
    seconds      integer not null check (seconds >= 0),
    primary key (timesheet_id, url_host)
);

create table timesheet_category_totals (
    timesheet_id uuid    not null references timesheets (id) on delete cascade,
    category     text    not null,
    seconds      integer not null check (seconds >= 0),
    primary key (timesheet_id, category)
);

create table timesheet_project_totals (
    timesheet_id uuid    not null references timesheets (id) on delete cascade,
    project_id   uuid    not null references projects (id) on delete cascade,
    seconds      integer not null check (seconds >= 0),
    primary key (timesheet_id, project_id)
);

-- ---------------------------------------------------------------------------
-- Audit log — who viewed whose data
-- ---------------------------------------------------------------------------

create table audit_log (
    id                  bigint      generated always as identity primary key,
    org_id              uuid        not null references organizations (id) on delete cascade,

    -- actor_email and actor_role are denormalised copies so the trail stays readable
    -- after a user row is deleted or a role changes. Deleting a user must not quietly
    -- rewrite history.
    actor_user_id       uuid        references users (id) on delete set null,
    actor_email         text        not null,
    actor_role          text        not null,

    action              text        not null check (length(action) between 1 and 80),
    subject_type        text        not null check (length(subject_type) between 1 and 60),
    subject_id          text,
    subject_employee_id uuid        references employees (id) on delete set null,

    ip                  inet,
    user_agent          text,
    metadata            jsonb       not null default '{}'::jsonb,
    created_at          timestamptz not null default now()
);

create index audit_log_org_time_idx on audit_log (org_id, created_at desc);
create index audit_log_subject_idx
    on audit_log (org_id, subject_employee_id, created_at desc)
    where subject_employee_id is not null;
create index audit_log_action_idx on audit_log (org_id, action, created_at desc);

comment on table audit_log is
    'Append-only record of every access to employee data, every configuration change, '
    'every export, and every device revocation. Retained through data-deletion runs on '
    'purpose: a deletion you cannot evidence is worse than no deletion at all.';

-- ---------------------------------------------------------------------------
-- Data deletion (right to erasure)
-- ---------------------------------------------------------------------------

create table data_deletion_requests (
    id                       uuid        primary key default gen_random_uuid(),
    org_id                   uuid        not null references organizations (id) on delete cascade,
    employee_id              uuid        not null references employees (id) on delete cascade,
    scope                    text        not null check (scope in ('all', 'screenshots', 'events')),
    requested_by_user_id     uuid        references users (id) on delete set null,
    reason                   text,
    requested_at             timestamptz not null default now(),
    status                   text        not null default 'pending'
                                 check (status in ('pending', 'completed', 'failed')),
    completed_at             timestamptz,
    deleted_event_count      integer     check (deleted_event_count is null or deleted_event_count >= 0),
    deleted_screenshot_count integer     check (deleted_screenshot_count is null or deleted_screenshot_count >= 0),
    error                    text,

    constraint deletion_completed_chk check ((status = 'pending') = (completed_at is null))
);

create index deletion_requests_org_idx on data_deletion_requests (org_id, requested_at desc);
create index deletion_requests_pending_idx on data_deletion_requests (requested_at)
    where status = 'pending';

comment on table data_deletion_requests is
    'Drives a genuine hard delete: activity_events and screenshots rows are DELETEd and '
    'the S3 objects removed, with the resulting counts recorded here.';

