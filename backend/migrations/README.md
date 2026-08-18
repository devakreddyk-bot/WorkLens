# Migrations

Forward-only, numbered SQL files. A file that has been applied anywhere is never edited —
corrections ship as a new, higher-numbered migration. `scripts/migrate.ts` records the
sha256 of every file it applies and **refuses to run** if an already-applied file's
contents have changed, so an accidental edit fails loudly instead of producing two
databases with the same version number and different schemas.

## Transactions

The files deliberately contain **no `BEGIN` / `COMMIT`**. The runner wraps each migration
and its `schema_migrations` ledger row in one transaction, so a migration either applies
completely and is recorded, or does neither. Putting `BEGIN`/`COMMIT` in the files would
break that atomicity: the ledger insert would land outside the migration's transaction and
a crash in between would leave the schema changed but unrecorded.

If a future migration genuinely cannot run inside a transaction — `CREATE INDEX
CONCURRENTLY` and `ALTER TYPE ... ADD VALUE` are the usual cases — name it with the
`.no-transaction.sql` suffix. The runner detects the suffix, runs the file outside a
transaction, and records the ledger row separately. That trade-off is explicit at the
filename level rather than hidden inside the file.

## Applying them

```bash
make migrate
```

or directly:

```bash
cd backend && npm run migrate
```

Connection settings come from the environment (see `backend/.env.example`). Locally, set
`DB_PASSWORD` for password auth. In AWS, leave it unset and the runner uses RDS IAM
authentication, signing a short-lived token with the caller's AWS credentials.

Two useful flags:

- `npm run migrate -- --dry-run` — report what would be applied, touch nothing.
- `npm run migrate -- --status` — print the ledger and any pending files.

## Who runs them

Migrations connect as the **RDS master user** (or `worklens_migrator` once it exists),
because `0003_app_role.sql` grants `rds_iam`, which requires `rds_superuser`. The
application's Lambdas connect as `worklens_app`, which has DML rights only — it cannot
create, alter, or drop anything, and cannot touch the migration ledger.

## The order matters

| File | What it establishes |
|---|---|
| `0001_init.sql` | The whole schema: orgs, employees, users, devices, enrollment, ingest idempotency, activity, screenshots, config, timesheets, audit log, deletion requests. |
| `0002_org_bootstrap.sql` | The default category template and `wl_seed_org_defaults()`, so creating an org is one atomic call. Also `wl_sweep_device_nonces()`. |
| `0003_app_role.sql` | The `worklens_app` / `worklens_migrator` roles and their grants. Must come last, because it grants on the objects the earlier files created. |

## Before adding a migration

Read the privacy invariant at the top of `0001_init.sql`. There is no column anywhere in
this schema for keystroke content, key codes, clipboard contents, audio, or video, and
none may be added. `scripts/check-privacy.sh` fails the build if the word `keystroke`
appears in any `.sql` file at all.
