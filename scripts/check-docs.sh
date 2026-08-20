#!/usr/bin/env bash
# Fails the build on a documentation link that goes nowhere.
#
# # Why this is worth a gate
#
# This repository's documentation is load-bearing in a way most projects' is not. A deployer is
# told to read `docs/RESPONSIBLE_USE.md` before collecting anybody's data, and `README.md`'s
# responsible-use section is itself enforced by `check-readme.sh`. A dead link there is not a
# cosmetic problem: it is an instruction that cannot be followed.
#
# It is also the single easiest thing to get wrong. Every one of these documents cross-references
# the others, the filenames were decided before the files existed, and a rename updates one end of
# a link and not the other. While Phase 7 was being written, README.md pointed at three documents
# that did not exist yet and nothing noticed — which is how this script came to be.
#
# Two kinds of reference are checked, because both are used and both rot:
#
#   - Markdown links to a path, `[text](docs/THING.md)` and `[text](docs/THING.md#anchor)`.
#   - Inline-code references in prose, `` `docs/THING.md` `` and `` `scripts/thing.sh` ``, which
#     read as pointers and are relied on as such even though nothing renders them as links.
#
# External URLs are deliberately not checked. Reaching the network from a build gate makes it fail
# for reasons that have nothing to do with the change being tested, and a link-rot check that
# depends on somebody else's uptime gets switched off within a month.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

echo "check-docs: resolving documentation references..."

python3 - <<'PY'
import os
import re
import subprocess
import sys

files = subprocess.run(
    ["git", "ls-files", "*.md"], capture_output=True, text=True, check=True
).stdout.split()

# `[text](target)` where target is relative — no scheme, no bare anchor.
LINK = re.compile(r"\[[^\]]*\]\((?!https?://|mailto:|#)([^)\s]+)\)")

# A backticked path that looks like a repository file. Conservative on purpose: a false positive
# means failing a build over prose, which is worse than missing one stale reference.
CODE_REF = re.compile(r"`([A-Za-z0-9_./-]+\.(?:md|sh|ts|tsx|go|sql|tf|json|yml|yaml))`")

# Prose in this repository routinely names a path relative to the component under discussion —
# `src/shared/config.ts` in a paragraph about the backend, `internal/privacy/rules.go` in one about
# the agent. That is how a person writes and how a reader reads, so a reference resolves if it lands
# anywhere sensible rather than only at the repository root.
COMPONENT_ROOTS = ["", "agent", "backend", "dashboard", "infra", "docs", "scripts"]

# GitHub resolves a relative link from a repository page, so `../../discussions` works on github.com
# and is a broken path on disk. Left as-is rather than rewritten to an absolute URL, which would
# break for a fork.
GITHUB_RELATIVE = re.compile(r"^\.\./\.\./(discussions|issues|pulls|security|wiki)(/.*)?$")

# Files a deployer creates from a committed template, or that a build generates.
ALLOWED_MISSING = {
    "backend/.env",            # from backend/.env.example, via `make env-backend`
    "dashboard/.env.local",    # from the dashboard template, via `make env-dashboard`
    "infra/terraform.tfvars",  # from infra/terraform.tfvars.example
    "backend/dist",            # produced by `make backend-build`
}

# The two historical records. docs/PLAN.md is the Phase 0 design and docs/MASTER_BUILD_PROMPT.md the
# original requirement; both name files by the layout that was *proposed*, and the implementation
# deviated in ways those documents themselves record (middleware/hmacAuth.ts became
# middleware/deviceAuth.ts; the device handlers moved under handlers/device/). Correcting their paths
# now would falsify the record of what was planned, so their prose references are not checked. Their
# markdown links still are — a reader clicking one should still arrive somewhere.
HISTORICAL = {"docs/PLAN.md", "docs/MASTER_BUILD_PROMPT.md"}


def resolves(target: str, doc_dir: str) -> bool:
    if target in ALLOWED_MISSING:
        return True
    if os.path.exists(os.path.normpath(os.path.join(doc_dir, target))):
        return True
    return any(os.path.exists(os.path.normpath(os.path.join(r, target))) for r in COMPONENT_ROOTS)


failures = []

for path in files:
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.readlines()
    except (OSError, UnicodeDecodeError):
        continue

    base = os.path.dirname(path)
    in_fence = False

    for number, line in enumerate(lines, start=1):
        # Fenced blocks hold example commands and sample output, where a path is illustrative.
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue

        for match in LINK.finditer(line):
            raw = match.group(1)
            target = raw.split("#", 1)[0]
            if target == "" or GITHUB_RELATIVE.match(target):
                continue
            if not resolves(target, base):
                failures.append((path, number, "link -> " + raw))

        if path in HISTORICAL:
            continue

        for match in CODE_REF.finditer(line):
            target = match.group(1)
            # A bare `config.ts` is a filename in prose, not a pointer; resolving it is guesswork.
            if "/" not in target:
                continue
            # Shaped like a pattern rather than a path: `.go/.ts/.tsx` and similar.
            if target.startswith(".") or target.count(".") > 3:
                continue
            if not resolves(target, base):
                failures.append((path, number, "reference -> " + target))

if failures:
    print(file=sys.stderr)
    print("Documentation references that go nowhere:", file=sys.stderr)
    for path, number, what in failures:
        print("  %s:%d  %s" % (path, number, what), file=sys.stderr)
    print(file=sys.stderr)
    print("Fix the path, create the file, or — if the path is deliberately not in the", file=sys.stderr)
    print("repository — add it to ALLOWED_MISSING in scripts/check-docs.sh with a reason.", file=sys.stderr)
    print(file=sys.stderr)
    print("check-docs: FAILED (%d broken reference(s))." % len(failures), file=sys.stderr)
    sys.exit(1)

print("check-docs: OK — every reference in %d markdown file(s) resolves." % len(files))
PY
