#!/usr/bin/env bash
#
# check-privacy.sh — enforce WorkLens' hard privacy constraints as a build gate.
#
# WorkLens promises, in README.md and docs/PLAN.md, that it never captures
# keystroke content, passwords, clipboard contents, webcam frames or audio.
# A promise that only lives in prose decays. This script turns it into a test:
# if source code references the operating-system APIs or the concepts that
# would make such capture possible, the build fails.
#
# What is scanned
#   Only source files, by extension: .go .ts .tsx .js .sql .tf
#   Documentation (.md), shell scripts and this checker's own allowlist are
#   never scanned, so prose of the form "WorkLens does not call
#   SetWindowsHookEx" is free to say so.
#
# What is skipped inside a scanned file
#   * Comment content: // line comments, /* block comments */ tracked across
#     lines, # comments in Terraform, and -- comments in SQL. A comment cannot
#     open a keyboard hook, and explaining in a code comment why an API is not
#     used is good practice this gate must not punish.
#   * SQL string literals ('...', including '' escapes and multi-line
#     literals). In a .sql file a quoted string is documentation or data, never
#     schema — COMMENT ON TABLE ... IS '... no keystroke column exists ...' is
#     precisely the kind of statement the project wants to encourage. String
#     literals in .go/.ts/.js/.tf are NOT skipped, because there a literal is
#     how an API gets called (syscall.NewProc("SetWindowsHookExW")).
#
# The SQL rule
#   Outside comments and string literals, the string "keystroke" must not
#   appear in a .sql file at all. There is no keystroke column in the schema
#   and there may never be one, so any occurrence in executable SQL — a column
#   name, an index, a view, an ALTER — fails.
#
# Escape hatch
#   scripts/privacy-allowlist.txt, which requires a privacy review per
#   CONTRIBUTING.md. It ships empty and should stay that way.
#
# Exit status
#   0 — clean.  1 — at least one violation, each printed as file:line.
#   2 — the checker could not run (missing allowlist file).
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ALLOWLIST="scripts/privacy-allowlist.txt"

# Forbidden terms, matched case-insensitively as substrings of executable
# code. Win32 / WinMM / WASAPI entry points first, then the concepts.
FORBIDDEN_TERM_LIST="
SetWindowsHookEx
GetAsyncKeyState
GetKeyboardState
WH_KEYBOARD
RegisterRawInputDevices
OpenClipboard
GetClipboardData
keylog
keystroke_content
clipboard_content
webcam
VideoCapture
waveIn
IAudioCaptureClient
"

# awk's -v cannot portably carry embedded newlines (BWK awk on macOS rejects
# them), so flatten the readable list above into a space-separated string.
FORBIDDEN_TERMS="$(printf '%s' "$FORBIDDEN_TERM_LIST" | tr '\n' ' ')"

# Extensions that count as code for the purposes of this gate.
is_scannable() {
  case "$1" in
    *.go | *.ts | *.tsx | *.js | *.sql | *.tf) return 0 ;;
    *) return 1 ;;
  esac
}

# Enumerate candidate files. Inside a Git work tree we list tracked files plus
# untracked-but-not-ignored files, so the gate covers work in progress and
# still honours .gitignore (vendor/, node_modules/, .terraform/). Outside a
# work tree — an exported tarball, for instance — fall back to find.
collect_candidates() {
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git ls-files --cached --others --exclude-standard -z
  else
    find . \
      \( -name .git -o -name node_modules -o -name vendor \
         -o -name .terraform -o -name dist -o -name .next \) -prune -o \
      -type f -print0
  fi
}

files=()
while IFS= read -r -d '' candidate; do
  candidate="${candidate#./}"
  if is_scannable "$candidate" && [ -f "$candidate" ]; then
    files+=("$candidate")
  fi
done < <(collect_candidates)

if [ "${#files[@]}" -eq 0 ]; then
  echo "check-privacy: no .go/.ts/.tsx/.js/.sql/.tf files present yet — nothing to scan."
  exit 0
fi

if [ ! -f "$ALLOWLIST" ]; then
  echo "check-privacy: FATAL: missing $ALLOWLIST (it must exist, even if empty)." >&2
  exit 2
fi

echo "check-privacy: scanning ${#files[@]} source file(s) for forbidden capture APIs..."

set +e
awk \
  -v allowfile="$ALLOWLIST" \
  -v terms="$FORBIDDEN_TERMS" \
  '
  BEGIN {
    nterms = 0
    n = split(terms, raw, " ")
    for (i = 1; i <= n; i++) {
      t = raw[i]
      gsub(/^[ \t\r]+/, "", t)
      gsub(/[ \t\r]+$/, "", t)
      if (t == "") continue
      nterms++
      term[nterms] = t
      lterm[nterms] = tolower(t)
    }

    # Allowlist: "path" allows every term in that file, "path:TERM" allows one.
    while ((getline aline < allowfile) > 0) {
      sub(/#.*$/, "", aline)
      gsub(/^[ \t\r]+/, "", aline)
      gsub(/[ \t\r]+$/, "", aline)
      if (aline == "") continue
      c = index(aline, ":")
      if (c == 0) {
        allow_file[aline] = 1
      } else {
        allow_term[substr(aline, 1, c - 1) SUBSEP tolower(substr(aline, c + 1))] = 1
      }
    }
    close(allowfile)

    violations = 0
  }

  # Per-file state reset. inblock and instr carry an open /* ... */ or an open
  # SQL string literal across line boundaries.
  FNR == 1 {
    inblock = 0
    instr = 0
    ext = FILENAME
    sub(/^.*\./, "", ext)
    skipfile = (FILENAME in allow_file)
  }

  skipfile { next }

  {
    if (ext == "sql") {
      code = strip_sql($0)
    } else {
      code = strip_clike($0, ext)
    }
    if (code == "") next
    lower = tolower(code)

    for (i = 1; i <= nterms; i++) {
      if (index(lower, lterm[i]) > 0) {
        if ((FILENAME SUBSEP lterm[i]) in allow_term) continue
        printf "%s:%d: forbidden capture reference \"%s\"\n", FILENAME, FNR, term[i]
        violations++
      }
    }

    # No keystroke column may ever exist. Any executable SQL mentioning it
    # fails, over and above the generic term list.
    if (ext == "sql" && index(lower, "keystroke") > 0) {
      if (!((FILENAME SUBSEP "keystroke") in allow_term)) {
        printf "%s:%d: the string \"keystroke\" is not permitted in executable SQL — no such column may exist\n", FILENAME, FNR
        violations++
      }
    }
  }

  END {
    if (violations > 0) exit 1
    exit 0
  }

  # Executable part of a C-like line: block comments removed (state in the
  # global inblock), then the line comment for the language removed. String
  # literals are deliberately kept — a literal is how a syscall is named.
  function strip_clike(line, e,   out, p, q, rest) {
    out = ""
    rest = line

    while (rest != "") {
      if (inblock) {
        q = index(rest, "*/")
        if (q == 0) { rest = ""; break }
        rest = substr(rest, q + 2)
        inblock = 0
        continue
      }
      p = index(rest, "/*")
      if (p == 0) { out = out rest; rest = ""; break }
      out = out substr(rest, 1, p - 1)
      rest = substr(rest, p + 2)
      inblock = 1
    }

    p = index(out, "//")
    if (p > 0) out = substr(out, 1, p - 1)
    if (e == "tf") {
      p = index(out, "#")
      if (p > 0) out = substr(out, 1, p - 1)
    }

    gsub(/^[ \t\r]+/, "", out)
    gsub(/[ \t\r]+$/, "", out)
    return out
  }

  # Executable part of a SQL line. A left-to-right lexer, because -- inside a
  # string literal is not a comment and a quote inside a comment is not a
  # string. Handles /* */ block comments, -- line comments, and '\''...'\''
  # literals with '\'''\'' escapes; inblock and instr persist across lines.
  function strip_sql(line,   out, i, len, ch, two) {
    out = ""
    i = 1
    len = length(line)
    while (i <= len) {
      ch = substr(line, i, 1)
      two = substr(line, i, 2)

      if (instr) {
        if (ch == "'\''") {
          if (substr(line, i + 1, 1) == "'\''") { i += 2; continue }
          instr = 0
          i++
          continue
        }
        i++
        continue
      }
      if (inblock) {
        if (two == "*/") { inblock = 0; i += 2; continue }
        i++
        continue
      }
      if (two == "--") break
      if (two == "/*") { inblock = 1; i += 2; continue }
      if (ch == "'\''") { instr = 1; i++; continue }

      out = out ch
      i++
    }

    gsub(/^[ \t\r]+/, "", out)
    gsub(/[ \t\r]+$/, "", out)
    return out
  }
  ' "${files[@]}"
status=$?
set -e

if [ "$status" -eq 0 ]; then
  echo "check-privacy: OK — no forbidden capture references found."
  exit 0
fi

cat >&2 <<'MSG'

check-privacy: FAILED.

Each line above is a file:line in scanned source code that references an API
or concept WorkLens has committed to never using. Fix it by removing the
reference. If — and only if — the reference genuinely does not enable capture
of employee content, add an entry to scripts/privacy-allowlist.txt and
justify it in the pull request's privacy-impact section, per CONTRIBUTING.md.
MSG
exit 1
