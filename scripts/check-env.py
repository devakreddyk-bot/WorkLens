import os
import re
import sys

repo = os.getcwd()
failures = []


def read(path):
    with open(os.path.join(repo, path), encoding="utf-8") as fh:
        return fh.read()


def names_in_example(path):
    return set(re.findall(r"^([A-Z][A-Z0-9_]+)=", read(path), re.M))


# --- backend: src/shared/config.ts is the authority --------------------------------------
# The schema object is a flat list of `  KEY: <zod expression>` at two-space indentation.
BACKEND_EXAMPLE = "backend/.env.example"
BACKEND_SCHEMA = "backend/src/shared/config.ts"

# Read by scripts/migrate.ts, which loads backend/.env directly. The Lambdas never run migrations,
# so config.ts has no such key and never will. Each entry documents its consumer.
MIGRATION_CLI_ONLY = {
    "DB_MIGRATOR_USER",  # scripts/migrate.ts: the role migrations connect as
    "DB_SSL_CA_PATH",  # scripts/migrate.ts: overrides the committed trust store
}

if os.path.isfile(os.path.join(repo, BACKEND_SCHEMA)):
    schema = set(re.findall(r"^\s{2}([A-Z][A-Z0-9_]+):", read(BACKEND_SCHEMA), re.M))
    if not schema:
        print("check-env: parsed no keys from config.ts — refusing to pass vacuously.", file=sys.stderr)
        sys.exit(1)

    example = names_in_example(BACKEND_EXAMPLE)
    cli_used = set()
    for name in MIGRATION_CLI_ONLY:
        if re.search(rf"\b{name}\b", read("backend/scripts/migrate.ts")):
            cli_used.add(name)

    for name in sorted(schema - example):
        failures.append((BACKEND_EXAMPLE, f"{name} is read by config.ts and absent here"))
    for name in sorted(example - schema - cli_used):
        failures.append((BACKEND_EXAMPLE, f"{name} is listed here and read by nothing"))
    for name in sorted(MIGRATION_CLI_ONLY - cli_used):
        failures.append(("scripts/check-env.sh", f"{name} is allowlisted but migrate.ts no longer reads it"))

# --- dashboard: src/lib/env.ts is the authority ------------------------------------------
DASH_EXAMPLE = "dashboard/.env.example"
DASH_SCHEMA = "dashboard/src/lib/env.ts"

if os.path.isfile(os.path.join(repo, DASH_SCHEMA)):
    required = set(re.findall(r"NEXT_PUBLIC_[A-Z_]+", read(DASH_SCHEMA)))
    if not required:
        print("check-env: parsed no keys from env.ts — refusing to pass vacuously.", file=sys.stderr)
        sys.exit(1)

    example = names_in_example(DASH_EXAMPLE)
    for name in sorted(required - example):
        failures.append((DASH_EXAMPLE, f"{name} is required by env.ts and absent here"))
    for name in sorted(example - required):
        failures.append((DASH_EXAMPLE, f"{name} is listed here and read by nothing"))

if failures:
    print(file=sys.stderr)
    print("Environment templates disagree with the code that reads them:", file=sys.stderr)
    for path, what in failures:
        print(f"  {path}: {what}", file=sys.stderr)
    print(file=sys.stderr)
    print("A name the code does not read is silently ignored, which is worse than an error:", file=sys.stderr)
    print("a deployer sets it, nothing changes, and nothing says so.", file=sys.stderr)
    print(file=sys.stderr)
    print(f"check-env: FAILED ({len(failures)} disagreement(s)).", file=sys.stderr)
    sys.exit(1)

print("check-env: OK — both .env.example files match the code that reads them.")
