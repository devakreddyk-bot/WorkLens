-- 0003_app_role.sql — least-privilege application role for IAM database authentication
--
-- The Lambdas connect to RDS with IAM authentication (docs/PLAN.md deviation D6): the
-- SDK signs a short-lived token locally, so no database password exists anywhere and no
-- Secrets Manager round trip is needed from inside the VPC.
--
-- Two roles are created:
--   worklens_app       — the data plane. DML only, no DDL, no ability to read or write
--                        the migration ledger. This is the role every Lambda uses.
--   worklens_migrator  — schema changes. Used only by scripts/migrate.ts.
--
-- The application role deliberately cannot ALTER or DROP anything. A compromised Lambda
-- can read and write rows it is scoped to; it cannot drop the audit log.
--
-- This migration must be applied by the RDS master user, because only a member of
-- rds_superuser can grant rds_iam. The migration runner connects as the master user for
-- migrations, which satisfies that.

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------

do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'worklens_app') then
        -- No password: authentication is exclusively via IAM.
        create role worklens_app with login;
    end if;

    if not exists (select 1 from pg_roles where rolname = 'worklens_migrator') then
        create role worklens_migrator with login;
    end if;
end;
$$;

-- rds_iam is what makes `IAM database authentication` work for these roles. It does not
-- exist on a plain local Postgres, so this is tolerant of its absence to keep local
-- development and CI working against a vanilla container.
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'rds_iam') then
        grant rds_iam to worklens_app;
        grant rds_iam to worklens_migrator;
    else
        raise notice 'rds_iam role not present (not an RDS instance) — skipping IAM grants';
    end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Schema and connection privileges
-- ---------------------------------------------------------------------------

grant usage on schema public to worklens_app, worklens_migrator;

-- Postgres 15+ removed the implicit public CREATE grant on the public schema; make the
-- intent explicit rather than relying on the version's default.
revoke create on schema public from public;
grant create on schema public to worklens_migrator;

-- ---------------------------------------------------------------------------
-- Data-plane privileges: DML on tenant tables, nothing more
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on
    organizations,
    employees,
    users,
    projects,
    project_rules,
    app_categories,
    devices,
    enrollment_tokens,
    ingest_batches,
    device_nonces,
    activity_events,
    screenshots,
    monitoring_config,
    timesheets,
    timesheet_app_totals,
    timesheet_site_totals,
    timesheet_category_totals,
    timesheet_project_totals,
    data_deletion_requests
to worklens_app;

-- The audit log is append-only for the application. Without UPDATE or DELETE, a bug or
-- a compromised handler cannot rewrite or erase the record of who read whose data.
grant select, insert on audit_log to worklens_app;

-- Reference data is read-only at runtime; it changes by migration.
grant select on default_app_categories to worklens_app;

-- The migration ledger is not readable by the data plane: nothing in a request path has
-- any business knowing or changing it.
grant select, insert, update, delete on schema_migrations to worklens_migrator;

-- Identity columns need sequence usage for INSERT.
grant usage, select on all sequences in schema public to worklens_app;

grant execute on function wl_seed_org_defaults(uuid) to worklens_app;
grant execute on function wl_sweep_device_nonces(interval) to worklens_app;

-- ---------------------------------------------------------------------------
-- Future objects
-- ---------------------------------------------------------------------------
-- Default privileges apply to objects created later BY THE MIGRATOR, which is the only
-- role that can create them. Without this, every new table in a later migration would
-- silently be invisible to the application until someone remembered to grant on it.

alter default privileges for role worklens_migrator in schema public
    grant select, insert, update, delete on tables to worklens_app;

alter default privileges for role worklens_migrator in schema public
    grant usage, select on sequences to worklens_app;

