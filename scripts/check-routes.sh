#!/usr/bin/env bash
# Fails the build if the dashboard calls an endpoint the backend does not serve.
#
# # Why this exists
#
# dashboard/src/lib/api.ts hand-declares the request paths and response types for every
# backend endpoint the browser tier uses. It does that deliberately: the two tiers deploy
# separately, so importing the backend's Zod schemas across the boundary would couple a
# dashboard build to a backend source tree it may not be released alongside. That reasoning
# is sound, and it has a cost — the declarations are a copy, and a copy drifts.
#
# It drifted. api.ts was originally written from the design document rather than from the
# handlers, and shipped calls to `/timesheets/team` and to a `/timesheets/{date}/breakdown`
# sub-route, neither of which exists: the team register is a projection of `/overview`, and
# the breakdown is an `include_breakdown` flag on the range query. Nothing caught it. Both
# tiers type-checked cleanly, because each was internally consistent — the dashboard's
# `tsc` has no way to know what the backend serves, which is the whole point of the
# separation. A 404 at runtime was the first available signal.
#
# So the boundary keeps its decoupling, and this script supplies the agreement that the
# type system cannot. It is deliberately one-directional: an endpoint the backend serves and
# the dashboard never calls is normal (the agent's own routes, anything not yet surfaced).
# The reverse — a call with no route behind it — is always a bug.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
client="$repo_root/dashboard/src/lib/api.ts"
handlers="$repo_root/backend/src/handlers"

for f in "$client" "$handlers"; do
  if [[ ! -e "$f" ]]; then
    echo "check-routes: ${f#"$repo_root"/} not present yet — skipping." >&2
    exit 0
  fi
done

echo "check-routes: comparing dashboard/src/lib/api.ts against the backend route tables..."

python3 - "$client" "$handlers" <<'PY'
import os
import re
import sys

client_path, handlers_dir = sys.argv[1], sys.argv[2]

# A path with its variable segments flattened, so `/employees/${encodeURIComponent(id)}/activity`
# and `/employees/{id}/activity` compare equal. Only the shape is checked; parameter names are
# each side's own business.
PARAM = re.compile(r"\$\{[^}]*\}|\{[^}]*\}")


def shape(path: str) -> str:
    return PARAM.sub("{}", path)


# --- what the dashboard calls -------------------------------------------------------------
# `apiRequest<T>('/path', { method: 'PUT', ... })` or with a template literal. The options
# object routinely runs onto later lines, so the method cannot be read from the path's own
# line — but it must not be looked for in a fixed window after it either. A bare
# `apiRequest('/devices')` followed by a POST helper put the *next* call's method on this
# one, and the first version of this script duly reported a POST /devices that no route
# served. So the search is bounded by the call's own argument list.
with open(client_path, encoding="utf-8") as fh:
    client_src = fh.read()


def call_arguments(text: str, open_paren: int) -> str:
    """The text between `(` and its matching `)`. Template holes such as
    `${encodeURIComponent(id)}` nest legitimately, so parentheses are counted rather than
    stopping at the first close."""
    depth = 0
    for i in range(open_paren, len(text)):
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
            if depth == 0:
                return text[open_paren + 1 : i]
    return ""


called: dict[tuple[str, str], int] = {}
for match in re.finditer(r"apiRequest(?:<[^>]*>)?(\()\s*[`']([^`']+)[`']", client_src):
    arguments = call_arguments(client_src, match.start(1))
    method = re.search(r"method:\s*'([A-Z]+)'", arguments)
    key = (method.group(1) if method else "GET", shape(match.group(2)))
    called.setdefault(key, client_src.count("\n", 0, match.start()) + 1)

# --- what the backend serves -------------------------------------------------------------
# Route entries are `{ method: 'GET', path: '/me', ... }`, frequently split across lines by
# the formatter, so method and path are paired by proximity rather than per-line.
served: set[tuple[str, str]] = set()
ENTRY = re.compile(r"method:\s*'([A-Z]+)',\s*\n?\s*path:\s*'([^']+)'")
for root, _, files in os.walk(handlers_dir):
    for name in files:
        if not name.endswith(".ts") or name.endswith(".test.ts"):
            continue
        with open(os.path.join(root, name), encoding="utf-8") as fh:
            for method, path in ENTRY.findall(fh.read()):
                served.add((method, shape(path)))

if not served:
    print("check-routes: found no route tables to compare against — refusing to pass "
          "vacuously.", file=sys.stderr)
    sys.exit(1)

missing = sorted((m, p, line) for (m, p), line in called.items() if (m, p) not in served)

if missing:
    print(file=sys.stderr)
    print("Called by the dashboard, served by no backend route:", file=sys.stderr)
    for method, path, line in missing:
        print(f"  {method:6} {path}    dashboard/src/lib/api.ts:{line}", file=sys.stderr)
    print(file=sys.stderr)
    print("These type-check on both sides and 404 at runtime. Fix the call to match the", file=sys.stderr)
    print("route table in backend/src/handlers/, or add the route.", file=sys.stderr)
    print(file=sys.stderr)
    print("check-routes: FAILED.", file=sys.stderr)
    sys.exit(1)

print(f"check-routes: OK — all {len(called)} call(s) match a route "
      f"({len(served)} served in total).")
PY
