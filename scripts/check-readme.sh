#!/usr/bin/env bash
#
# check-readme.sh — the responsible-use section is a shipped feature, so test it.
#
# WorkLens is monitoring software. docs/PLAN.md treats the README's
# "Responsible & Lawful Use" section as a hard requirement rather than
# documentation polish: it is where a deployer learns what is and is not
# collected, and that employee notice, consent and jurisdiction-specific legal
# sign-off are their responsibility. A refactor that quietly drops that section
# changes the product, so CI fails when it goes missing or loses substance.
#
# The gate checks two things:
#   1. README.md contains a Markdown heading "Responsible & Lawful Use"
#      ("and" is accepted in place of "&"; the heading may be any level).
#   2. That section — from the heading to the next heading of the same or a
#      higher level — mentions every one of: keystroke, password, webcam,
#      microphone, consent, DPDP. Matching is case-insensitive and substring
#      based, so "passwords" and "microphones" both count.
#
# Missing README.md
#   Exits 1 with an explanatory message, because a repository that ships
#   monitoring software without a README has no responsible-use notice at all.
#   Set ALLOW_MISSING_README=1 to downgrade that to a warning and exit 0. That
#   variable exists for the short window during initial scaffolding when the
#   README has not been written yet; CI deliberately does not set it, so the
#   pipeline fails until the README exists.
#
# Exit status
#   0 — the section is present and complete (or README.md is absent and
#       ALLOW_MISSING_README=1).
#   1 — README.md is absent, the heading is missing, or a required topic is
#       not covered in the section.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

README="README.md"
REQUIRED_TOPICS="keystroke password webcam microphone consent dpdp"

if [ ! -f "$README" ]; then
  if [ "${ALLOW_MISSING_README:-0}" = "1" ]; then
    echo "check-readme: WARNING: $README is not present yet."
    echo "check-readme: ALLOW_MISSING_README=1 is set, so this is not a failure."
    echo "check-readme: the Responsible & Lawful Use section is still required before release."
    exit 0
  fi
  cat >&2 <<'MSG'
check-readme: FAILED: README.md is not present yet.

WorkLens ships employee-monitoring software, so its README must carry a
"Responsible & Lawful Use" section covering keystroke content, passwords,
webcam, microphone, employee consent, and India's DPDP Act 2023.

If you are mid-scaffold and the README genuinely does not exist yet, run this
check with ALLOW_MISSING_README=1 to downgrade the failure to a warning. CI
does not set that variable, so the pipeline stays red until README.md exists.
MSG
  exit 1
fi

echo "check-readme: checking the Responsible & Lawful Use section in $README..."

set +e
awk -v topics="$REQUIRED_TOPICS" '
  BEGIN {
    ntopics = split(topics, topic, " ")
    for (i = 1; i <= ntopics; i++) seen[i] = 0
    found_heading = 0
    heading_line = 0
    heading_level = 0
    insection = 0
    fenced = 0
  }

  # Never read headings out of a fenced code block.
  /^[ \t]*(```|~~~)/ { fenced = !fenced }

  {
    if (fenced) { collect(); next }

    if (match($0, /^#+[ \t]/)) {
      level = 0
      while (substr($0, level + 1, 1) == "#") level++
      title = substr($0, level + 1)
      gsub(/^[ \t]+/, "", title)
      gsub(/[ \t#]+$/, "", title)

      if (insection && level <= heading_level) insection = 0

      if (!found_heading && is_responsible_use(title)) {
        found_heading = 1
        heading_line = FNR
        heading_level = level
        insection = 1
        next
      }
    }
    collect()
  }

  END {
    if (!found_heading) {
      print "README.md:1: missing a Markdown heading \"Responsible & Lawful Use\""
      exit 1
    }

    missing = 0
    for (i = 1; i <= ntopics; i++) {
      if (!seen[i]) {
        printf "README.md:%d: the \"Responsible & Lawful Use\" section does not mention \"%s\"\n", heading_line, topic[i]
        missing++
      }
    }
    if (missing > 0) exit 1
    printf "check-readme: section found at README.md:%d, all %d required topics covered.\n", heading_line, ntopics
    exit 0
  }

  # Accept "Responsible & Lawful Use" and the "and" spelling, ignoring case,
  # surrounding emphasis markers and trailing punctuation.
  function is_responsible_use(t,   s) {
    s = tolower(t)
    gsub(/[*_`]/, "", s)
    gsub(/[ \t]+/, " ", s)
    gsub(/^ +/, "", s)
    gsub(/ +$/, "", s)
    if (s == "responsible & lawful use") return 1
    if (s == "responsible and lawful use") return 1
    return 0
  }

  # Record which required topics appear in the section body.
  function collect(   s, i) {
    if (!insection) return
    s = tolower($0)
    for (i = 1; i <= ntopics; i++) {
      if (index(s, topic[i]) > 0) seen[i] = 1
    }
  }
' "$README"
status=$?
set -e

if [ "$status" -eq 0 ]; then
  echo "check-readme: OK."
  exit 0
fi

cat >&2 <<'MSG'

check-readme: FAILED.

README.md must contain a prominent "Responsible & Lawful Use" section, and
that section must state plainly that WorkLens does not capture keystroke
content, passwords, webcam or microphone data; that deployers must give
employees informed notice and obtain consent; and that legal sign-off for the
deployment jurisdiction is required, calling out India's DPDP Act 2023.

Restore the section rather than relaxing this check.
MSG
exit 1
