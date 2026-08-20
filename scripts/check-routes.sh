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
#
# # The second comparison: API Gateway against the handlers
#
# There is a *third* hand-maintained route list, in `infra/modules/api/main.tf`, and it is the
# one that decides what is reachable at all. It drifted too, and worse. `POST /aggregation/run`
# was wired straight at the `aggregate-timesheets` job Lambda, which takes an `AggregateEvent`
# rather than a proxy event and reads no Cognito claim — so it ran for every organisation with
# default arguments, performed no authorisation whatsoever, and returned a shape the gateway
# rejects. Any signed-in user of any role could trigger it.
#
# That is the failure this half exists to catch: a route exposed by the gateway whose target has
# no entry in a handler router has not been through the POLICY table, because the POLICY table
# lives in those routers. A route in a router but not in the gateway is the milder direction —
# unreachable rather than unguarded — and is reported too, since it is dead code either way.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
client="$repo_root/dashboard/src/lib/api.ts"
handlers="$repo_root/backend/src/handlers"
gateway="$repo_root/infra/modules/api/main.tf"

for f in "$client" "$handlers"; do
  if [[ ! -e "$f" ]]; then
    echo "check-routes: ${f#"$repo_root"/} not present yet — skipping." >&2
    exit 0
  fi
done

echo "check-routes: comparing dashboard/src/lib/api.ts against the backend route tables..."

python3 - "$client" "$handlers" "$gateway" <<'PY'
import os
import re
import sys

client_path, handlers_dir, gateway_path = sys.argv[1], sys.argv[2], sys.argv[3]

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

# --- what API Gateway exposes -------------------------------------------------------------
# The route map keys in the api module are exactly `"METHOD /path"`. Device routes are mounted
# under /device/ and answered by single-purpose Lambdas with no router, so they are listed
# separately rather than compared.
gateway: set[tuple[str, str]] = set()
if os.path.isfile(gateway_path):
    with open(gateway_path, encoding="utf-8") as fh:
        gateway_src = fh.read()
    for match in re.finditer(r'^\s*"([A-Z]+) (/[^"]*)"\s*=\s*\{', gateway_src, re.M):
        gateway.add((match.group(1), shape(match.group(2))))

device = {(m, p) for m, p in gateway if p == "/device" or p.startswith("/device/")}
gateway_dashboard = gateway - device

status = 0

if gateway_dashboard:
    unguarded = sorted(gateway_dashboard - served)
    unreachable = sorted(served - gateway_dashboard)

    if unguarded:
        status = 1
        print(file=sys.stderr)
        print("Exposed by API Gateway with no handler route behind it:", file=sys.stderr)
        for method, path in unguarded:
            print(f"  {method:6} {path}", file=sys.stderr)
        print(file=sys.stderr)
        print("A route with no entry in a handler router has not been through the POLICY table,", file=sys.stderr)
        print("because that is where the POLICY table is applied. Either route it at a handler", file=sys.stderr)
        print("that authorises it, or remove it from infra/modules/api/main.tf.", file=sys.stderr)

    if unreachable:
        status = 1
        print(file=sys.stderr)
        print("Served by a handler but not exposed by API Gateway (dead code):", file=sys.stderr)
        for method, path in unreachable:
            print(f"  {method:6} {path}", file=sys.stderr)
        print(file=sys.stderr)
        print("Add it to the route map in infra/modules/api/main.tf, or delete the handler.", file=sys.stderr)
else:
    print("check-routes: no gateway route map found — skipping the gateway comparison.", file=sys.stderr)

if status != 0:
    print(file=sys.stderr)
    print("check-routes: FAILED.", file=sys.stderr)
    sys.exit(1)

print(f"check-routes: OK — {len(called)} dashboard call(s) match a handler route; "
      f"{len(gateway_dashboard)} gateway route(s) agree with {len(served)} served "
      f"({len(device)} device route(s) not compared).")
PY
