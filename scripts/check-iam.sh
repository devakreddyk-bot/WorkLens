#!/usr/bin/env bash
#
# check-iam.sh — fail the build on unjustified IAM resource wildcards.
#
# docs/PLAN.md, Section 6 item 3, commits WorkLens to least-privilege IAM: one
# role per Lambda, and no "Resource": "*" in any policy. A handful of AWS
# actions genuinely have no resource-level permissions and must be granted with
# a wildcard. Rather than pretend otherwise, this gate demands that each such
# case be annotated with a reason a reviewer can weigh:
#
#   # iam-wildcard-ok: ec2:CreateNetworkInterface has no resource-level
#   # permissions; scoped by the VPC condition key below.
#   Resource = "*"
#
# The annotation may sit on the offending line or on the line immediately
# above it, in a # or // comment, and it must carry text after the colon — an
# empty annotation is itself reported as a violation.
#
# Recognised forms, case-insensitive, including inside jsonencode({...}) and
# JSON heredocs:
#
#   Resource  = "*"          "Resource": "*"          resources = ["*"]
#   Resource  = ["*", "arn:aws:s3:::b/*"]
#   Resource  = [
#     "*"
#   ]
#
# A scoped wildcard such as "arn:aws:s3:::bucket/*" is not a violation: only a
# resource element that is exactly "*" is flagged.
#
# Exit status
#   0 — clean, or infra/ does not exist yet.
#   1 — at least one violation, each printed as file:line.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

INFRA_DIR="infra"

if [ ! -d "$INFRA_DIR" ]; then
  echo "check-iam: skipping: $INFRA_DIR/ not yet present."
  exit 0
fi

files=()
while IFS= read -r -d '' f; do
  files+=("$f")
done < <(find "$INFRA_DIR" -type d -name .terraform -prune -o -type f -name '*.tf' -print0)

if [ "${#files[@]}" -eq 0 ]; then
  echo "check-iam: skipping: no .tf files under $INFRA_DIR/ yet."
  exit 0
fi

echo "check-iam: scanning ${#files[@]} Terraform file(s) for IAM resource wildcards..."

set +e
awk '
  BEGIN { violations = 0 }

  FNR == 1 {
    prev_ok = 0
    depth = 0
    inarray = 0
    key_ok = 0
    key_line = 0
  }

  {
    line = $0
    this_ok = annotation_state(line)
    code = strip_comment(line)

    if (inarray) {
      if (star_in(code)) {
        if (!(this_ok == 1 || prev_ok == 1 || key_ok == 1)) {
          report(FILENAME, FNR, key_line, this_ok, prev_ok, key_ok)
        }
      }
      depth += bracket_delta(code)
      if (depth <= 0) inarray = 0
      prev_ok = this_ok
      next
    }

    value = resource_value(code)
    if (value != "") {
      if (star_in(value)) {
        if (!(this_ok == 1 || prev_ok == 1)) {
          report(FILENAME, FNR, 0, this_ok, prev_ok, 0)
        }
      }
      d = bracket_delta(value)
      if (d > 0) {
        inarray = 1
        depth = d
        key_ok = (this_ok == 1 || prev_ok == 1) ? 1 : 0
        key_line = FNR
      }
    }

    prev_ok = this_ok
  }

  END {
    if (violations > 0) exit 1
    exit 0
  }

  # 1 = annotated with a justification, 2 = annotated but empty, 0 = absent.
  # The marker must appear inside a # or // comment.
  function annotation_state(s,   pos, prefix, rest, i, ch) {
    pos = index(tolower(s), "iam-wildcard-ok")
    if (pos == 0) return 0

    prefix = substr(s, 1, pos - 1)
    if (index(prefix, "#") == 0 && index(prefix, "//") == 0) return 0

    rest = substr(s, pos + length("iam-wildcard-ok"))
    gsub(/^[ \t]+/, "", rest)
    if (substr(rest, 1, 1) != ":") return 2
    rest = substr(rest, 2)
    gsub(/^[ \t\r]+/, "", rest)
    gsub(/[ \t\r]+$/, "", rest)
    if (rest == "") return 2
    return 1
  }

  # Drop # and // comments, but never a marker inside a string literal.
  function strip_comment(s,   i, len, ch, two, instr, out) {
    out = ""
    instr = 0
    i = 1
    len = length(s)
    while (i <= len) {
      ch = substr(s, i, 1)
      two = substr(s, i, 2)
      if (instr) {
        if (ch == "\\") { out = out "  "; i += 2; continue }
        if (ch == "\"") { instr = 0 }
        out = out ch
        i++
        continue
      }
      if (ch == "\"") { instr = 1; out = out ch; i++; continue }
      if (ch == "#") break
      if (two == "//") break
      out = out ch
      i++
    }
    return out
  }

  # If the line assigns a Resource / resources key, return the value text.
  # Returns "" when the line is not a resource assignment. A leading space is
  # prepended so the word-boundary test needs no anchor inside a group.
  function resource_value(s,   padded, lower) {
    padded = " " s
    lower = tolower(padded)
    if (match(lower, /[^a-z0-9_]"?resources?"?[ \t]*[=:]/) == 0) return ""
    return substr(padded, RSTART + RLENGTH)
  }

  # True when a double-quoted token in s is exactly "*".
  function star_in(s,   i, len, ch, tok, instr) {
    instr = 0
    tok = ""
    i = 1
    len = length(s)
    while (i <= len) {
      ch = substr(s, i, 1)
      if (instr) {
        if (ch == "\\") { tok = tok "\\"; i += 2; continue }
        if (ch == "\"") {
          if (tok == "*") return 1
          instr = 0
          tok = ""
          i++
          continue
        }
        tok = tok ch
        i++
        continue
      }
      if (ch == "\"") { instr = 1; tok = ""; i++; continue }
      i++
    }
    return 0
  }

  # Net change in [ nesting, ignoring brackets inside string literals.
  function bracket_delta(s,   i, len, ch, instr, d) {
    instr = 0
    d = 0
    i = 1
    len = length(s)
    while (i <= len) {
      ch = substr(s, i, 1)
      if (instr) {
        if (ch == "\\") { i += 2; continue }
        if (ch == "\"") instr = 0
        i++
        continue
      }
      if (ch == "\"") { instr = 1; i++; continue }
      if (ch == "[") d++
      if (ch == "]") d--
      i++
    }
    return d
  }

  function report(file, ln, keyln, a, b, c,   why) {
    if (a == 2 || b == 2 || c == 2) {
      why = "iam-wildcard-ok annotation has no justification text after the colon"
    } else {
      why = "IAM Resource wildcard \"*\" without a \"# iam-wildcard-ok:\" justification"
    }
    if (keyln > 0 && keyln != ln) {
      printf "%s:%d: %s (Resource list opened at line %d)\n", file, ln, why, keyln
    } else {
      printf "%s:%d: %s\n", file, ln, why
    }
    violations++
  }
  ' "${files[@]}"
status=$?
set -e

if [ "$status" -eq 0 ]; then
  echo "check-iam: OK — no unjustified IAM resource wildcards."
  exit 0
fi

cat >&2 <<'MSG'

check-iam: FAILED.

Each line above grants an IAM permission on every resource in the account.
Scope it to explicit ARNs. If the action truly has no resource-level
permissions, keep the wildcard and annotate it, on the same line or the line
directly above:

  # iam-wildcard-ok: <action> has no resource-level permissions; constrained
  # by the <condition key> condition below.

An annotation without a reason is treated as no annotation at all.
MSG
exit 1
