#!/usr/bin/env bash
# Cross-checks the Lambda inventory between the two places that declare it.
#
# backend/functions.json drives `make backend-build` (which zip is produced) and
# infra/modules/lambda/main.tf drives the deployment (which function exists). They are two
# hand-maintained lists, so they can drift — and the failure mode is nasty in both
# directions: a function in Terraform with no zip fails the apply half-way through, and a
# zip with no function is simply never deployed while everything looks fine.
#
# An earlier version of functions.json claimed Terraform read it with
# `jsondecode(file(...))`. It does not. This script is what makes the two lists agree.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
manifest="$repo_root/backend/functions.json"
catalogue="$repo_root/infra/modules/lambda/main.tf"

for f in "$manifest" "$catalogue"; do
  if [[ ! -f "$f" ]]; then
    echo "check-functions: ${f#"$repo_root"/} not present yet — skipping." >&2
    exit 0
  fi
done

echo "check-functions: comparing backend/functions.json with infra/modules/lambda/main.tf..."

from_manifest="$(python3 -c '
import json, sys
with open(sys.argv[1]) as fh:
    data = json.load(fh)
for name in sorted(f["name"] for f in data["functions"]):
    print(name)
' "$manifest")"

# Catalogue keys are the map keys inside data_plane_functions / migrate_function: four
# spaces, a quoted lowercase-hyphen name, then ` = {`.
from_catalogue="$(grep -oE '^    "[a-z0-9-]+" = \{' "$catalogue" | sed -E 's/^ *"([a-z0-9-]+)".*/\1/' | sort)"

only_manifest="$(comm -23 <(printf '%s\n' "$from_manifest") <(printf '%s\n' "$from_catalogue"))"
only_catalogue="$(comm -13 <(printf '%s\n' "$from_manifest") <(printf '%s\n' "$from_catalogue"))"

status=0

if [[ -n "$only_manifest" ]]; then
  status=1
  echo >&2
  echo "In backend/functions.json but NOT in infra/modules/lambda/main.tf:" >&2
  printf '  %s\n' $only_manifest >&2
  echo "  -> these would be built and never deployed." >&2
fi

if [[ -n "$only_catalogue" ]]; then
  status=1
  echo >&2
  echo "In infra/modules/lambda/main.tf but NOT in backend/functions.json:" >&2
  printf '  %s\n' $only_catalogue >&2
  echo "  -> terraform apply would fail on a missing deployment package." >&2
fi

if [[ $status -ne 0 ]]; then
  echo >&2
  echo "check-functions: FAILED. Add the function to both lists." >&2
  exit 1
fi

count="$(printf '%s\n' "$from_manifest" | grep -c .)"
echo "check-functions: OK — both lists declare the same $count function(s)."
