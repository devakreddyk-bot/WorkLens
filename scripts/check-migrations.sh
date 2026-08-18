#!/usr/bin/env bash
# Every migration file must be registered in the db-migrate Lambda's bundle list.
#
# RDS has no public access, so backend/src/handlers/jobs/dbMigrate.ts is the only route
# migrations have into the deployed database — and it carries them as imported strings,
# because a Lambda has no repository to read from. ESM has no import-time glob, so that
# list is written by hand.
#
# The failure this prevents is quiet and bad: add 0004_*.sql, deploy, invoke the Lambda,
# and it reports success having applied nothing. The local CLI reads the directory, so
# development would look fine while production silently lacked the migration.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
migrations_dir="$repo_root/backend/migrations"
handler="$repo_root/backend/src/handlers/jobs/dbMigrate.ts"

for path in "$migrations_dir" "$handler"; do
  if [[ ! -e "$path" ]]; then
    echo "check-migrations: ${path#"$repo_root"/} not present yet — skipping." >&2
    exit 0
  fi
done

echo "check-migrations: checking every migration is bundled into the db-migrate Lambda..."

on_disk="$(find "$migrations_dir" -maxdepth 1 -name '*.sql' -exec basename {} \; | sort)"

# Matches the `{ file: '0001_init.sql', sql: ... }` entries in BUNDLED_MIGRATIONS.
registered="$(grep -oE "file: '[0-9]{4}_[a-z0-9_]+(\.no-transaction)?\.sql'" "$handler" \
  | sed -E "s/file: '(.*)'/\1/" | sort -u)"

missing="$(comm -23 <(printf '%s\n' "$on_disk") <(printf '%s\n' "$registered"))"
extra="$(comm -13 <(printf '%s\n' "$on_disk") <(printf '%s\n' "$registered"))"

status=0

if [[ -n "$missing" ]]; then
  status=1
  echo >&2
  echo "Migration file(s) NOT registered in ${handler#"$repo_root"/}:" >&2
  printf '  %s\n' $missing >&2
  echo >&2
  echo "  Add an import and a BUNDLED_MIGRATIONS entry for each. Without it the deployed" >&2
  echo "  database silently never receives the migration, while local development, which" >&2
  echo "  reads the directory, looks correct." >&2
fi

if [[ -n "$extra" ]]; then
  status=1
  echo >&2
  echo "Registered in the Lambda but not present in backend/migrations/:" >&2
  printf '  %s\n' $extra >&2
  echo "  The import will fail the build. Remove the entry, or restore the file." >&2
fi

if [[ $status -ne 0 ]]; then
  echo >&2
  echo "check-migrations: FAILED." >&2
  exit 1
fi

echo "check-migrations: OK — all $(printf '%s\n' "$on_disk" | grep -c .) migration(s) are bundled."
