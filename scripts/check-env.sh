#!/usr/bin/env bash
# Fails the build when an .env.example disagrees with the code that reads it.
#
# # Why this is a gate and not a review item
#
# An environment variable the code does not read is **silently ignored**. That is a worse failure
# than an error: a deployer sets it, nothing changes, and nothing anywhere says so.
#
# It happened. `backend/.env.example` used seven names the code had since renamed —
# `DEVICE_SIGNATURE_WINDOW_SECONDS` for `HMAC_TIMESTAMP_SKEW_SECONDS`,
# `S3_PRESIGN_VIEW_TTL_SECONDS` for `PRESIGN_VIEW_EXPIRY_SECONDS`, and five more. Someone shortening
# a screenshot URL's life to thirty seconds, for a product whose argument is that it handles this
# data carefully, would have edited the documented variable, deployed, and changed nothing at all.
# `DB_USER` — which `config.ts` requires and has no default for — was absent entirely, while
# `dashboard/.env.example` listed a `COGNITO_ISSUER_URL` that nothing reads.
#
# Neither file is loaded by a test, so no test could have caught it, and both look plausible on
# review because every individual line is a sensible-looking variable with a good comment.
#
# The authorities are `backend/src/shared/config.ts` (which validates the Lambda environment at
# module load) and `dashboard/src/lib/env.ts` (which refuses to start without its four values).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

for f in backend/.env.example dashboard/.env.example; do
  if [[ ! -f "$f" ]]; then
    echo "check-env: $f not present yet — skipping." >&2
    exit 0
  fi
done

echo "check-env: comparing the .env.example files against the code that reads them..."
python3 scripts/check-env.py
